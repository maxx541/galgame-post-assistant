"""
用 Playwright 讀 Facebook／Instagram 貼文的內文與圖片。

跟 x_scraper.py 同一套路數（瀏覽器憑證重用），但 FB 與 IG 是同一個 Meta 帳號體系，
所以共用一份 profile：data/.browser/meta。在裡面登入過 facebook.com 與 instagram.com 之後，
兩邊的 cookie 都在同一個 persistent context 裡，抓取時不必再登入。

未登入時多半只讀得到公開貼文的 og: 標籤（IG 另外走 /embed/ 備援），
內容會不完整，所以 loggedIn 會一起回報，讓上層決定要不要提醒。

用法：
    py tools/social_scraper.py --site fb --login          # 開瀏覽器登入 Facebook
    py tools/social_scraper.py --site ig --login          # 開瀏覽器登入 Instagram
    py tools/social_scraper.py --status                   # 回報 profile 與兩邊的登入狀態
    py tools/social_scraper.py --url <貼文網址>            # 抓內文與圖片網址（站別由網址判斷）
    py tools/social_scraper.py --url <網址> --images-dir DIR
    py tools/social_scraper.py --images-dir DIR --download <圖片網址> ...

一律把結果以單行 JSON 印到 stdout；出錯時 JSON 帶 error 欄位並以非 0 結束。
診斷訊息一律走 stderr，不會污染 stdout。
"""

import argparse
import json
import re
import sys
import time
from pathlib import Path
from urllib.parse import unquote, urlparse, parse_qs

# Windows 的 stdout 預設不是 UTF-8，強制轉掉，否則中文 JSON 會壞
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
PROFILE_DIR = ROOT / "data" / ".browser" / "meta"
STATE_FILE = ROOT / "data" / ".browser" / "meta-state.json"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

SITES = {
    "fb": {
        "name": "Facebook",
        "login_url": "https://www.facebook.com/login",
        # c_user 是登入後才有的使用者編號 cookie
        "cookie": ("c_user",),
        "domain": "facebook.com",
    },
    "ig": {
        "name": "Instagram",
        "login_url": "https://www.instagram.com/accounts/login/",
        "cookie": ("sessionid", "ds_user_id"),
        "domain": "instagram.com",
    },
}


def out(obj, code=0):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))
    sys.stdout.flush()
    sys.exit(code)


def log(*a):
    print(*a, file=sys.stderr)


def site_of(url: str):
    """從網址判斷是 fb 還是 ig，都不是就回 None"""
    try:
        h = urlparse(url).hostname or ""
    except Exception:
        return None
    h = h.lower().replace("www.", "")
    if h in ("facebook.com", "m.facebook.com", "web.facebook.com", "fb.com", "fb.watch") or h.endswith(
        ".facebook.com"
    ):
        return "fb"
    if h in ("instagram.com", "instagr.am", "ddinstagram.com") or h.endswith(".instagram.com"):
        return "ig"
    return None


def save_state(state: dict):
    """把登入狀態寫成小檔案，Node 端查狀態就不必再開一次 Chromium"""
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(
            json.dumps({**state, "at": time.strftime("%Y-%m-%dT%H:%M:%S")}, ensure_ascii=False),
            encoding="utf-8",
        )
    except Exception as e:
        log("寫入狀態檔失敗", e)


def need_playwright():
    try:
        from playwright.sync_api import sync_playwright  # noqa: F401
        return True
    except ImportError:
        out(
            {
                "error": "playwright_missing",
                "message": "Python 沒裝 playwright。執行：py -m pip install playwright 然後 py -m playwright install chromium",
            },
            2,
        )


def launch(p, headless=True):
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    return p.chromium.launch_persistent_context(
        user_data_dir=str(PROFILE_DIR),
        headless=headless,
        user_agent=UA,
        viewport={"width": 1280, "height": 1600},
        locale="zh-TW",
        args=["--disable-blink-features=AutomationControlled"],
    )


def login_map(ctx) -> dict:
    """回傳 {'fb': bool, 'ig': bool}——同一個 context 裡兩個網域的 cookie 都看得到"""
    got = {"fb": False, "ig": False}
    try:
        cookies = ctx.cookies()
    except Exception:
        return got
    for key, cfg in SITES.items():
        for c in cookies:
            if c.get("name") not in cfg["cookie"] or not c.get("value"):
                continue
            if cfg["domain"] in (c.get("domain") or ""):
                got[key] = True
                break
    return got


def cmd_status():
    need_playwright()
    from playwright.sync_api import sync_playwright

    if not PROFILE_DIR.exists():
        out(
            {
                "ready": False,
                "loggedIn": {"fb": False, "ig": False},
                "profile": str(PROFILE_DIR),
                "message": "還沒建立瀏覽器 profile",
            }
        )
    with sync_playwright() as p:
        ctx = launch(p, headless=True)
        try:
            got = login_map(ctx)
        finally:
            ctx.close()
    save_state({"loggedIn": got})
    out({"ready": True, "loggedIn": got, "profile": str(PROFILE_DIR)})


def cmd_login(site: str, timeout_s=600):
    """開一個有頭的瀏覽器讓使用者自己登入，偵測到該站的 cookie 就結束"""
    need_playwright()
    from playwright.sync_api import sync_playwright

    cfg = SITES[site]
    with sync_playwright() as p:
        ctx = launch(p, headless=False)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        try:
            page.goto(cfg["login_url"], wait_until="domcontentloaded", timeout=60000)
        except Exception as e:
            log("開啟登入頁失敗：", e)
        log(f"請在開啟的瀏覽器視窗登入 {cfg['name']}。登入完成後這個程式會自動偵測並結束。")
        deadline = time.time() + timeout_s
        got = {"fb": False, "ig": False}
        while time.time() < deadline:
            try:
                got = login_map(ctx)
                if got.get(site):
                    break
                if not ctx.pages:
                    break
            except Exception:
                break
            time.sleep(2)
        try:
            ctx.close()
        except Exception:
            pass
    save_state({"loggedIn": got})
    if got.get(site):
        out({"loggedIn": got, "site": site, "profile": str(PROFILE_DIR)})
    out(
        {
            "loggedIn": got,
            "site": site,
            "error": "login_timeout",
            "message": f"沒有偵測到登入 {cfg['name']}（可能是視窗被關掉或逾時）",
        },
        1,
    )


# ── 共用的小工具 ────────────────────────────────────────────────

def clean(s: str) -> str:
    return re.sub(r"\n{3,}", "\n\n", (s or "").strip())


def unshim(href: str) -> str:
    """
    Meta 的外連會包一層轉址（l.facebook.com/l.php?u=…、l.instagram.com/?u=…），
    真正的網址在 u 參數裡。拆不開就原樣回傳。
    """
    try:
        u = urlparse(href)
        if u.hostname and u.hostname.startswith("l.") and ("facebook.com" in u.hostname or "instagram.com" in u.hostname):
            q = parse_qs(u.query)
            real = (q.get("u") or q.get("url") or [""])[0]
            if real:
                return unquote(real)
    except Exception:
        pass
    return href


def meta_tag(page, keys) -> str:
    """讀 og:／twitter: 標籤——未登入時常常只剩這些"""
    for k in keys:
        try:
            v = page.get_attribute(f'meta[property="{k}"]', "content", timeout=1500)
            if v:
                return v.strip()
        except Exception:
            pass
        try:
            v = page.get_attribute(f'meta[name="{k}"]', "content", timeout=1500)
            if v:
                return v.strip()
        except Exception:
            pass
    return ""


def epoch_iso(n) -> str:
    try:
        t = int(n)
        if t > 1_000_000_000_000:  # 毫秒
            t //= 1000
        if t < 1_000_000_000:
            return ""
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))
    except Exception:
        return ""


def time_from_json(page, keys) -> str:
    """
    FB／IG 的頁面裡都埋著一包 JSON，發文時間在 creation_time／taken_at。
    DOM 上的時間戳是「3 小時前」這種相對字串，拿不到絕對時間，只能從這裡挖。
    """
    try:
        html = page.content()
    except Exception:
        return ""
    for k in keys:
        m = re.search(r'"%s"\s*:\s*(\d{10,13})' % k, html)
        if m:
            iso = epoch_iso(m.group(1))
            if iso:
                return iso
    return ""


# 圖片網址上的尺寸標記（p320x320、s150x150）用來剔掉頭像與縮圖
SMALL_MARK = re.compile(r"[ps](\d{2,3})x(\d{2,3})")

# Meta 的 CDN 用路徑前綴區分用途，這幾種不是貼文的圖：
#   t39.1997-  貼圖與表情符號圖集（很大張，光看尺寸擋不掉）
#   t39.30808-1 / t51.2885-19  大頭貼
#   rsrc.php、static.*fbcdn  介面素材
BAD_IMG = re.compile(r"/rsrc\.php/|/emoji|/t39\.1997-|/t39\.30808-1/|/t51\.2885-19/|//static\.", re.I)


def usable_img(url: str) -> bool:
    return bool(url) and not url.startswith("data:") and not BAD_IMG.search(url)


def merge_images(*groups, limit=12):
    """依序併圖並去重——同一張圖不同尺寸的網址只有查詢字串不一樣，用路徑當鍵"""
    seen, out_list = set(), []
    for g in groups:
        for u in g or []:
            if not usable_img(u):
                continue
            key = u.split("?")[0]
            if key in seen:
                continue
            seen.add(key)
            out_list.append(u)
            if len(out_list) >= limit:
                return out_list
    return out_list


def collect_images(page, scope_sel: str, hosts: tuple, min_px=280, limit=12):
    """
    收貼文區塊裡夠大的圖。Meta 的 DOM class 名是亂數，靠不住，
    所以用「CDN 網域 + 實際渲染尺寸」過濾——頭像、表情、介面圖示都會被擋掉。
    """
    try:
        items = page.evaluate(
            """([sel, hosts, minPx]) => {
              const root = document.querySelector(sel) || document.body
              const out = []
              for (const img of root.querySelectorAll('img')) {
                const src = img.currentSrc || img.src || ''
                if (!src || src.startsWith('data:')) continue
                if (!hosts.some(h => src.includes(h))) continue
                const w = Math.max(img.naturalWidth || 0, img.width || 0, img.clientWidth || 0)
                const h = Math.max(img.naturalHeight || 0, img.height || 0, img.clientHeight || 0)
                if (w < minPx || h < minPx) continue
                out.push({ src, w, h })
              }
              for (const v of root.querySelectorAll('video[poster]')) {
                const p = v.getAttribute('poster') || ''
                if (p && hosts.some(h => p.includes(h))) out.push({ src: p, w: minPx, h: minPx })
              }
              return out
            }""",
            [scope_sel, list(hosts), min_px],
        )
    except Exception as e:
        log("讀取圖片失敗", e)
        return []

    seen, urls = set(), []
    for it in items:
        src = it.get("src") or ""
        if not usable_img(src):
            continue
        m = SMALL_MARK.search(src)
        if m and (int(m.group(1)) < min_px or int(m.group(2)) < min_px):
            continue
        key = src.split("?")[0]
        if key in seen:
            continue
        seen.add(key)
        urls.append(src)
        if len(urls) >= limit:
            break
    return urls


def collect_links(page, scope_sel: str, skip_hosts: tuple, limit=8):
    """貼文內文裡的外部連結——這才是要貼到留言的東西"""
    out_links, seen = [], set()
    try:
        rows = page.evaluate(
            """(sel) => {
              const root = document.querySelector(sel) || document.body
              return [...root.querySelectorAll('a[href]')].map(a => ({
                href: a.href, text: (a.innerText || '').trim().slice(0, 120)
              }))
            }""",
            scope_sel,
        )
    except Exception:
        return out_links
    for r in rows:
        href = unshim(r.get("href") or "")
        if not href.lower().startswith("http"):
            continue
        try:
            host = (urlparse(href).hostname or "").lower().replace("www.", "")
        except Exception:
            continue
        if any(host == s or host.endswith("." + s) for s in skip_hosts):
            continue
        if href in seen:
            continue
        seen.add(href)
        label = " ".join((r.get("text") or "").split()).replace("https://", "").replace("http://", "")
        out_links.append({"url": href, "label": label})
        if len(out_links) >= limit:
            break
    return out_links


MORE_WORDS = ("查看更多", "顯示更多", "显示更多", "更多", "See more", "See More", "もっと見る", "続きを読む")


def expand_more(page, scope_sel: str):
    """
    把內文裡的「查看更多」按下去，不然只讀得到前幾行。

    只找貼文區塊內的按鈕——整頁掃會按到側欄或登入彈窗上的東西，
    實測那會把頁面導去首頁，貼文就整個不見了。按完網址變了就立刻停手。
    """
    here = page.url
    try:
        buttons = page.locator(f'{scope_sel} [role="button"], {scope_sel} button').all()[:40]
    except Exception:
        return
    for b in buttons:
        try:
            t = (b.inner_text(timeout=800) or "").strip()
        except Exception:
            continue
        if not t or len(t) > 12 or not any(w in t for w in MORE_WORDS):
            continue
        try:
            b.click(timeout=2000)
            page.wait_for_timeout(400)
        except Exception:
            pass
        if page.url != here:
            log("按了展開之後頁面被導走，停止展開")
            return


# ── Facebook ───────────────────────────────────────────────────

FB_HOSTS = ("fbcdn.net", "scontent")
FB_MSG_SEL = (
    '[data-ad-preview="message"], [data-ad-comet-preview="message"], '
    '[data-testid="post_message"], [data-testid="post-message"]'
)


def scrape_fb(page, result):
    try:
        page.wait_for_selector('div[role="article"], ' + FB_MSG_SEL, timeout=25000, state="attached")
    except Exception:
        log("等不到貼文區塊，改用 og: 標籤")
    try:
        page.mouse.wheel(0, 700)
        page.wait_for_timeout(600)
    except Exception:
        pass

    # 同 IG：沒有 role="article" 就是沒讀到貼文本體（多半是登入牆），
    # 這時只認 og: 標籤，不要在整個 body 上亂撈圖。
    has_article = page.locator('div[role="article"]').count() > 0
    scope = 'div[role="article"]' if has_article else "body"
    if has_article:
        expand_more(page, scope)

    text = ""
    try:
        msg = page.locator(FB_MSG_SEL).first
        if msg.count():
            text = msg.inner_text(timeout=5000)
    except Exception:
        pass
    if not text:
        text = meta_tag(page, ["og:description", "twitter:description", "description"])
    result["text"] = clean(text)

    # 作者：貼文標頭的第一個連結文字；讀不到就退回網址裡的專頁代號
    try:
        h = page.locator('div[role="article"] h2, div[role="article"] h3, div[role="article"] h4').first
        if h.count():
            result["author"] = clean(h.inner_text(timeout=3000)).split("\n")[0]
    except Exception:
        pass
    if not result["author"]:
        result["author"] = meta_tag(page, ["og:title"])
    seg = [s for s in urlparse(result["finalUrl"]).path.split("/") if s]
    if seg and seg[0] not in ("photo.php", "permalink.php", "share", "story.php", "watch", "reel", "posts", "groups"):
        result["handle"] = "@" + seg[0]

    result["createdAt"] = time_from_json(page, ["creation_time", "publish_time"])
    # og:image 是 FB 自己指定的貼文主圖，最準，排最前面
    og = meta_tag(page, ["og:image", "twitter:image"])
    result["images"] = merge_images([og], collect_images(page, scope, FB_HOSTS) if has_article else [])
    if has_article:
        result["links"] = collect_links(page, scope, ("facebook.com", "fb.com", "fb.me", "fb.watch", "messenger.com"))


# ── Instagram ──────────────────────────────────────────────────

IG_HOSTS = ("cdninstagram.com", "fbcdn.net")


def ig_shortcode(url: str) -> str:
    m = re.search(r"/(?:p|reel|reels|tv)/([A-Za-z0-9_-]+)", url or "")
    return m.group(1) if m else ""


def scrape_ig(page, result):
    try:
        page.wait_for_selector("article, main", timeout=25000, state="attached")
    except Exception:
        log("等不到貼文區塊，改用 og: 標籤")
    page.wait_for_timeout(500)

    # 登入後貼文本體是一個 <article>；沒登入時 IG 只給一頁塞滿推薦貼文的 main，
    # 在裡面撈圖會撈到一堆不相干的東西，寧可只認 og: 標籤與 embed 頁。
    has_article = page.locator("article").count() > 0
    scope = "article" if has_article else "main"
    if has_article:
        expand_more(page, scope)

    # 貼文頁的內文在 h1；讀不到就退回 og:description（未登入時多半只剩這個）
    text = ""
    for sel in ("article h1", "main h1", 'div[role="dialog"] h1'):
        try:
            loc = page.locator(sel).first
            if loc.count():
                t = clean(loc.inner_text(timeout=3000))
                if t:
                    text = t
                    break
        except Exception:
            continue
    if not text:
        text = ig_caption_from_og(meta_tag(page, ["og:description", "twitter:description"]))
    result["text"] = clean(text)

    # 作者：內文區塊裡指向個人檔案的第一個連結
    try:
        u = page.evaluate(
            """(sel) => {
              const root = document.querySelector(sel) || document.body
              for (const a of root.querySelectorAll('a[href^="/"]')) {
                const m = a.getAttribute('href').match(/^\\/([A-Za-z0-9._]+)\\/?$/)
                if (m && !['p','reel','reels','tv','explore','accounts'].includes(m[1])) return m[1]
              }
              return ''
            }""",
            scope,
        )
        if u:
            result["handle"] = "@" + u
            result["author"] = u
    except Exception:
        pass

    try:
        dt = page.get_attribute("time[datetime]", "datetime", timeout=3000)
        if dt:
            result["createdAt"] = dt
    except Exception:
        pass
    if not result["createdAt"]:
        result["createdAt"] = time_from_json(page, ["taken_at", "taken_at_timestamp"])

    if has_article:
        result["images"] = ig_carousel(page, scope)
        result["links"] = collect_links(page, scope, ("instagram.com", "instagr.am"))

    # 版面不完整（多半是沒登入）就再試一次官方 embed 頁，公開貼文不必登入
    if not has_article or not result["text"] or not result["images"]:
        code = ig_shortcode(result["finalUrl"] or result["url"])
        if code:
            ig_embed_fallback(page, result, code)


def ig_caption_from_og(desc: str) -> str:
    """
    og:description 長這樣：`123 likes, 4 comments - user on May 1, 2025: "真正的內文".`
    引號裡的才是內文，拆得出來就只留那段。
    """
    if not desc:
        return ""
    m = re.search(r'[:：]\s*[“"](.+)[”"]\s*[.。]?\s*$', desc.strip(), re.S)
    return (m.group(1) if m else desc).strip()


def ig_carousel(page, scope: str):
    """輪播貼文要按「下一張」才會載入後面的圖，最多翻 9 次"""
    urls, seen = [], set()

    def take():
        for u in collect_images(page, scope, IG_HOSTS, min_px=320, limit=12):
            key = u.split("?")[0]
            if key not in seen:
                seen.add(key)
                urls.append(u)

    take()
    for _ in range(9):
        moved = False
        for sel in ('button[aria-label="下一個"]', 'button[aria-label="Next"]', 'button[aria-label="下一張"]'):
            try:
                b = page.locator(sel).first
                if b.count():
                    b.click(timeout=2000)
                    page.wait_for_timeout(700)
                    moved = True
                    break
            except Exception:
                continue
        if not moved:
            break
        take()
    return merge_images([meta_tag(page, ["og:image", "twitter:image"])], urls)


def ig_embed_fallback(page, result, code: str):
    """官方 embed 頁不需要登入，公開貼文的內文與主圖都在裡面"""
    try:
        page.goto(
            f"https://www.instagram.com/p/{code}/embed/captioned/",
            wait_until="domcontentloaded",
            timeout=25000,
        )
        page.wait_for_timeout(1200)
    except Exception as e:
        log("embed 備援失敗", e)
        return
    if not result["text"]:
        for sel in (".Caption", "[class*=Caption]"):
            try:
                loc = page.locator(sel).first
                if loc.count():
                    t = clean(loc.inner_text(timeout=3000))
                    # embed 的 caption 前面會黏一段「帳號 分享的貼文」，切掉第一行
                    result["text"] = re.sub(r"^\s*\S+\s*$", "", t, count=1, flags=re.M).strip() or t
                    break
            except Exception:
                continue
    if not result["images"]:
        result["images"] = merge_images(
            [meta_tag(page, ["og:image"])], collect_images(page, "body", IG_HOSTS, min_px=200, limit=4), limit=4
        )
    if not result["handle"]:
        try:
            u = page.locator(".UsernameText, [class*=Username]").first
            if u.count():
                name = clean(u.inner_text(timeout=2000))
                if name:
                    result["handle"] = "@" + name
                    result["author"] = name
        except Exception:
            pass
    result["warning"] = (result["warning"] + " 內容改由 Instagram 官方 embed 頁讀取，只有主圖與內文。").strip()


# ── 抓取主流程 ─────────────────────────────────────────────────

def cmd_scrape(url: str, images_dir, headless: bool, timeout_ms: int):
    need_playwright()
    from playwright.sync_api import sync_playwright

    site = site_of(url)
    if not site:
        out({"error": "not_supported", "message": "這個網址不是 Facebook 或 Instagram：" + url}, 2)

    result = {
        "url": url,
        "finalUrl": url,
        "site": site,
        "siteName": SITES[site]["name"],
        "text": "",
        "author": "",
        "handle": "",
        "createdAt": "",
        "images": [],
        "links": [],
        "downloaded": [],
        "loggedIn": False,
        "warning": "",
    }

    with sync_playwright() as p:
        ctx = launch(p, headless=headless)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        try:
            got = login_map(ctx)
            result["loggedIn"] = bool(got.get(site))
            save_state({"loggedIn": got})

            try:
                page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
            except Exception as e:
                out({**result, "error": "goto_failed", "message": f"開啟頁面失敗：{e}"}, 1)
            result["finalUrl"] = page.url

            # 被丟去登入頁＝這則需要登入才看得到
            if re.search(r"/(login|accounts/login)", urlparse(page.url).path or ""):
                hint = (
                    f"{SITES[site]['name']} 把這個網址導去登入頁。"
                    + ("先在設定頁登入一次再抓。" if not result["loggedIn"] else "登入可能已失效，重新登入試試。")
                )
                out({**result, "error": "login_required", "message": hint}, 1)

            if site == "fb":
                scrape_fb(page, result)
            else:
                scrape_ig(page, result)

            if images_dir and result["images"]:
                d = Path(images_dir)
                d.mkdir(parents=True, exist_ok=True)
                for i, src in enumerate(result["images"], 1):
                    try:
                        resp = ctx.request.get(src, timeout=30000, headers={"referer": result["finalUrl"]})
                        if not resp.ok:
                            continue
                        body = resp.body()
                        if len(body) < 1024:
                            continue
                        ext = ".png" if ".png" in src.split("?")[0].lower() else ".jpg"
                        name = f"{i:02d}{ext}"
                        (d / name).write_bytes(body)
                        result["downloaded"].append(name)
                    except Exception as e:
                        log("下載失敗", src, e)

            if not result["text"] and not result["images"]:
                result["warning"] = (
                    result["warning"]
                    + (" 頁面有開起來，但內文與圖片都是空的。" if result["loggedIn"] else " 未登入，讀不到內容——先在設定頁登入。")
                ).strip()
            elif not result["loggedIn"]:
                result["warning"] = (result["warning"] + f" 目前未登入 {SITES[site]['name']}，內容可能不完整。").strip()
        finally:
            try:
                ctx.close()
            except Exception:
                pass

    out(result)


def cmd_download(urls, images_dir):
    """用已登入的 context 下載圖片，給 CDN 直連失敗時當備援"""
    need_playwright()
    from playwright.sync_api import sync_playwright

    d = Path(images_dir)
    d.mkdir(parents=True, exist_ok=True)
    saved, failed = [], []
    with sync_playwright() as p:
        ctx = launch(p, headless=True)
        try:
            for i, src in enumerate(urls, 1):
                try:
                    resp = ctx.request.get(src, timeout=30000)
                    if not resp.ok:
                        failed.append({"url": src, "reason": f"HTTP {resp.status}"})
                        continue
                    body = resp.body()
                    if len(body) < 1024:
                        failed.append({"url": src, "reason": "檔案太小"})
                        continue
                    ext = ".png" if ".png" in src.split("?")[0].lower() else ".jpg"
                    name = f"{i:02d}{ext}"
                    (d / name).write_bytes(body)
                    saved.append(name)
                except Exception as e:
                    failed.append({"url": src, "reason": str(e)})
        finally:
            try:
                ctx.close()
            except Exception:
                pass
    out({"downloaded": saved, "failed": failed})


def main():
    ap = argparse.ArgumentParser(description="用 Playwright 讀 Facebook／Instagram 貼文")
    ap.add_argument("--url")
    ap.add_argument("--site", choices=["fb", "ig"], help="登入時要登哪一邊；抓取時由網址判斷")
    ap.add_argument("--images-dir")
    ap.add_argument("--login", action="store_true")
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--headful", action="store_true", help="抓取時也開有頭瀏覽器，除錯用")
    ap.add_argument("--timeout", type=int, default=45000)
    ap.add_argument("--download", action="append", default=[], help="要下載的圖片網址，可重複")
    a = ap.parse_args()

    if a.status:
        cmd_status()
    if a.login:
        if not a.site:
            out({"error": "no_site", "message": "--login 要搭配 --site fb 或 --site ig"}, 2)
        cmd_login(a.site)
    if a.download:
        if not a.images_dir:
            out({"error": "no_images_dir", "message": "--download 需要搭配 --images-dir"}, 2)
        cmd_download(a.download, a.images_dir)
    if not a.url:
        out({"error": "no_url", "message": "要給 --url，或用 --login／--status"}, 2)
    cmd_scrape(a.url, a.images_dir, headless=not a.headful, timeout_ms=a.timeout)


if __name__ == "__main__":
    main()
