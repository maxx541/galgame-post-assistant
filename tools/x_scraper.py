"""
用 Playwright 讀 X／Twitter 貼文的內文與圖片。

X 對未登入的爬蟲擋得很兇，所以走「瀏覽器憑證重用」：
先用 --login 開一次真的瀏覽器手動登入，登入狀態存進 data/.browser/x（persistent context），
之後每次抓都重用同一份 profile，不必再登入。

用法：
    py tools/x_scraper.py --login                       # 開瀏覽器手動登入，登入後關掉視窗即可
    py tools/x_scraper.py --status                      # 回報 profile 與登入狀態
    py tools/x_scraper.py --url <推文網址>               # 抓內文與圖片網址
    py tools/x_scraper.py --url <網址> --images-dir DIR  # 順便把圖下載到 DIR

一律把結果以單行 JSON 印到 stdout；出錯時 JSON 帶 error 欄位並以非 0 結束。
診斷訊息一律走 stderr，不會污染 stdout。
"""

import argparse
import json
import re
import sys
import time
from pathlib import Path

# Windows 的 stdout 預設不是 UTF-8，強制轉掉，否則中文 JSON 會壞
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
PROFILE_DIR = ROOT / "data" / ".browser" / "x"
STATE_FILE = ROOT / "data" / ".browser" / "x-state.json"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

TWEET_SEL = 'article[data-testid="tweet"]'
TEXT_SEL = '[data-testid="tweetText"]'


def out(obj, code=0):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))
    sys.stdout.flush()
    sys.exit(code)


def log(*a):
    print(*a, file=sys.stderr)


def save_state(logged_in: bool):
    """把登入狀態寫成小檔案，Node 端查狀態就不必再開一次 Chromium"""
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(
            json.dumps({"loggedIn": bool(logged_in), "at": time.strftime("%Y-%m-%dT%H:%M:%S")}),
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


def logged_in(ctx) -> bool:
    """auth_token cookie 存在就當作已登入"""
    for c in ctx.cookies():
        if c.get("name") == "auth_token" and c.get("value"):
            return True
    return False


def cmd_status():
    need_playwright()
    from playwright.sync_api import sync_playwright

    if not PROFILE_DIR.exists():
        out({"ready": False, "loggedIn": False, "profile": str(PROFILE_DIR), "message": "還沒建立瀏覽器 profile"})
    with sync_playwright() as p:
        ctx = launch(p, headless=True)
        try:
            ok = logged_in(ctx)
        finally:
            ctx.close()
    save_state(ok)
    out({"ready": True, "loggedIn": ok, "profile": str(PROFILE_DIR)})


def cmd_login(timeout_s=600):
    """開一個有頭的瀏覽器讓使用者自己登入，偵測到 auth_token 就結束"""
    need_playwright()
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        ctx = launch(p, headless=False)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        try:
            page.goto("https://x.com/login", wait_until="domcontentloaded", timeout=60000)
        except Exception as e:
            log("開啟登入頁失敗：", e)
        log("請在開啟的瀏覽器視窗登入 X。登入完成後這個程式會自動偵測並結束。")
        deadline = time.time() + timeout_s
        ok = False
        while time.time() < deadline:
            try:
                if logged_in(ctx):
                    ok = True
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
    save_state(ok)
    if ok:
        out({"loggedIn": True, "profile": str(PROFILE_DIR)})
    out({"loggedIn": False, "error": "login_timeout", "message": "沒有偵測到登入（可能是視窗被關掉或逾時）"}, 1)


def upgrade_media(url: str) -> str:
    """把 pbs.twimg.com 縮圖網址換成原尺寸"""
    if "pbs.twimg.com" not in url:
        return url
    base = url.split("?")[0]
    fmt = "jpg"
    m = re.search(r"[?&]format=(\w+)", url)
    if m:
        fmt = m.group(1)
    elif base.endswith((".png", ".jpg", ".jpeg", ".webp")):
        fmt = base.rsplit(".", 1)[1]
        base = base.rsplit(".", 1)[0]
    return f"{base}?format={fmt}&name=orig"


ANY_ARTICLE = "article"


def wait_for_tweet(page, timeout_ms: int) -> bool:
    """
    X 的主欄偶爾會卡在 loading spinner（GraphQL 回來了但沒渲染）。
    先等推文出現，逾時就重新整理一次再等——實測這樣就救得回來。
    """
    for attempt in (1, 2):
        try:
            page.wait_for_selector(ANY_ARTICLE, timeout=timeout_ms, state="attached")
            return True
        except Exception:
            if attempt == 1:
                log("等不到推文，重新整理再試一次")
                try:
                    page.reload(wait_until="domcontentloaded", timeout=timeout_ms)
                except Exception as e:
                    log("重新整理失敗", e)
    return False


def cmd_scrape(url: str, images_dir: str | None, headless: bool, timeout_ms: int):
    need_playwright()
    from playwright.sync_api import sync_playwright

    result = {
        "url": url,
        "finalUrl": url,
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
            result["loggedIn"] = logged_in(ctx)
            save_state(result["loggedIn"])

            # 記錄 X 的 GraphQL 有沒有回應，失敗時才講得出原因
            gql = {"detail": 0, "errors": []}

            def on_resp(r):
                try:
                    u = r.url
                    if "TweetDetail" in u or "TweetResultByRestId" in u:
                        gql["detail"] = r.status
                    elif ("graphql" in u or "/i/api/" in u) and r.status >= 400:
                        gql["errors"].append(f"{r.status} {u.split('/')[-1].split('?')[0]}")
                except Exception:
                    pass

            page.on("response", on_resp)
            page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)

            if not wait_for_tweet(page, timeout_ms):
                body = ""
                try:
                    body = page.inner_text("body", timeout=5000)[:400]
                except Exception:
                    pass
                if not result["loggedIn"]:
                    hint = "讀不到推文。目前未登入，X 對訪客多半直接擋掉——先執行登入。"
                elif gql["detail"] == 200:
                    hint = "X 已回傳推文資料但畫面沒渲染出來（卡在載入中）。這是 X 偶發的狀況，重試一次通常就好。"
                elif gql["detail"]:
                    hint = f"X 回應推文資料時出錯（HTTP {gql['detail']}）。可能是推文已刪除、設為私密或需要年齡驗證。"
                elif gql["errors"]:
                    hint = "X 的 API 回應失敗：" + "、".join(gql["errors"][:3])
                else:
                    hint = "讀不到推文，X 沒有回應推文資料。可能是網路問題或登入已失效。"
                out({**result, "error": "tweet_not_found", "message": hint, "pageText": body}, 1)

            # 圖片是 lazy load，捲一下再抓
            try:
                page.mouse.wheel(0, 900)
                page.wait_for_timeout(700)
            except Exception:
                pass

            art = page.locator(TWEET_SEL).first
            if art.count() == 0:
                art = page.locator(ANY_ARTICLE).first
            result["finalUrl"] = page.url

            try:
                parts = art.locator(TEXT_SEL).all_inner_texts()
                result["text"] = "\n\n".join(t.strip() for t in parts if t.strip())
            except Exception:
                pass

            # 作者：User-Name 區塊通常是「顯示名稱\n@handle\n·\n日期」
            try:
                who = art.locator('[data-testid="User-Name"]').first.inner_text(timeout=5000)
                lines = [l.strip() for l in who.split("\n") if l.strip()]
                if lines:
                    result["author"] = lines[0]
                for l in lines:
                    if l.startswith("@"):
                        result["handle"] = l
                        break
            except Exception:
                pass
            if not result["handle"]:
                m = re.search(r"(?:x|twitter)\.com/([^/]+)/status", result["finalUrl"])
                if m and m.group(1).lower() not in ("i", "home"):
                    result["handle"] = "@" + m.group(1)

            try:
                result["createdAt"] = art.locator("time").first.get_attribute("datetime") or ""
            except Exception:
                pass

            # 推文內文裡的外部連結（t.co 會轉成真正的網址）——這才是要貼到留言的東西
            try:
                link_seen = set()
                for a in art.locator("a[href]").all():
                    href = a.get_attribute("href") or ""
                    if not href:
                        continue
                    if href.startswith("/"):
                        continue  # 站內連結（hashtag、帳號、推文本身）
                    low = href.lower()
                    if "x.com/" in low or "twitter.com/" in low:
                        continue
                    if not low.startswith("http"):
                        continue
                    try:
                        label = (a.inner_text(timeout=2000) or "").strip()
                    except Exception:
                        label = ""
                    if href in link_seen:
                        continue
                    link_seen.add(href)
                    # 顯示文字是被截斷過的網址，只拿來當備用標籤
                    label = " ".join(label.split()).replace("https://", "").replace("http://", "")
                    result["links"].append({"url": href, "label": label})
            except Exception as e:
                log("讀取推文連結失敗", e)

            seen = set()
            try:
                for img in art.locator('img[src*="pbs.twimg.com/media"]').all():
                    src = img.get_attribute("src") or ""
                    if not src:
                        continue
                    full = upgrade_media(src)
                    if full not in seen:
                        seen.add(full)
                        result["images"].append(full)
            except Exception:
                pass
            # 影片縮圖
            try:
                for v in art.locator('video[poster*="pbs.twimg.com"]').all():
                    poster = v.get_attribute("poster") or ""
                    if poster and poster not in seen:
                        seen.add(poster)
                        result["images"].append(poster)
            except Exception:
                pass

            if images_dir and result["images"]:
                d = Path(images_dir)
                d.mkdir(parents=True, exist_ok=True)
                for i, src in enumerate(result["images"], 1):
                    try:
                        resp = ctx.request.get(src, timeout=30000)
                        if not resp.ok:
                            continue
                        body = resp.body()
                        if len(body) < 1024:
                            continue
                        ext = ".png" if "format=png" in src else ".jpg"
                        name = f"{i:02d}{ext}"
                        (d / name).write_bytes(body)
                        result["downloaded"].append(name)
                    except Exception as e:
                        log("下載失敗", src, e)

            if not result["text"] and not result["images"]:
                result["warning"] = "推文有讀到，但內文與圖片都是空的"
        finally:
            try:
                ctx.close()
            except Exception:
                pass

    out(result)


# ── 時間軸（發掘功能用）──────────────────────────────────────────

def parse_count(txt):
    """
    把 X 顯示的數字轉成整數。可能長這樣：
      "1,234"  "1.2K"  "12万"  "1.5万"  "3.4M"  "24 replies"
    拿不到就回 0——互動數是加分項，缺了計分照樣能跑。
    """
    if not txt:
        return 0
    t = str(txt).replace(",", "").replace("\u00a0", " ").strip()
    m = re.search(r"(\d+(?:\.\d+)?)\s*([KkMm万萬千]?)", t)
    if not m:
        return 0
    n = float(m.group(1))
    unit = m.group(2)
    if unit in ("K", "k", "千"):
        n *= 1_000
    elif unit in ("M", "m"):
        n *= 1_000_000
    elif unit in ("万", "萬"):
        n *= 10_000
    return int(n)


# aria-label 的用詞會隨介面語言變，三種語言都收
_METRIC_WORDS = {
    "replies": ["repl", "返信", "回覆", "回复"],
    "reposts": ["repost", "retweet", "リポスト", "轉發", "转发", "轉推"],
    "likes": ["like", "いいね", "喜歡", "喜欢"],
    "views": ["view", "表示", "瀏覽", "浏览"],
}


def metrics_from_group(label):
    """
    最理想的來源：[role=group] 的 aria-label 一次帶出全部數字，
    例如 "12 replies, 34 reposts, 567 likes, 89 bookmarks, 12345 views"。
    用「數字 + 後面那個詞」配對，不靠順序。
    """
    out = {"replies": 0, "reposts": 0, "likes": 0, "views": 0}
    if not label:
        return out
    low = str(label).lower()
    for chunk in re.split(r"[,、，]", low):
        num = parse_count(chunk)
        if not num:
            continue
        for key, words in _METRIC_WORDS.items():
            if any(w in chunk for w in words):
                out[key] = max(out[key], num)
                break
    return out


def read_metrics(art):
    """三層退路：group aria-label → 各按鈕 aria-label → 按鈕顯示文字"""
    m = {"replies": 0, "reposts": 0, "likes": 0, "views": 0}
    try:
        g = art.locator('[role="group"]').first
        if g.count():
            m = metrics_from_group(g.get_attribute("aria-label"))
    except Exception:
        pass
    if any(m.values()):
        return m

    for key, tid in (("replies", "reply"), ("reposts", "retweet"), ("likes", "like")):
        try:
            b = art.locator(f'[data-testid="{tid}"]').first
            if not b.count():
                continue
            v = parse_count(b.get_attribute("aria-label"))
            if not v:
                v = parse_count(b.inner_text(timeout=1200))
            m[key] = v
        except Exception:
            pass
    try:
        a = art.locator('a[href*="/analytics"]').first
        if a.count():
            m["views"] = parse_count(a.get_attribute("aria-label") or a.inner_text(timeout=1200))
    except Exception:
        pass
    return m


_REPOST_MARKS = ["リポスト", "さんがリポスト", "轉推了", "轉發了", "转发了", "Reposted", "reposted"]
_REPLY_MARKS = ["返信先", "回覆", "回复", "Replying to"]
_PINNED_MARKS = ["固定されたポスト", "置頂", "已固定", "Pinned"]


def cmd_timeline(handle, limit, timeout_ms, headless=True, query=None):
    """讀一個帳號時間軸最新 N 則；給 query 時改讀關鍵字搜尋的熱門結果。

    兩種模式共用同一段解析，差別只在開哪個網址、以及要不要驗推文作者。
    搜尋模式是給「收錄時找不到圖」當備援用的，取 f=top（熱門）而不是 f=live，
    熱門結果比較可能帶主視覺圖。
    """
    need_playwright()
    from playwright.sync_api import sync_playwright

    searching = bool(query)
    handle = str(handle or "").lstrip("@").strip()
    if not searching and not handle:
        out({"error": "no_handle", "message": "要給帳號名"}, 2)

    if searching:
        from urllib.parse import quote
        url = f"https://x.com/search?q={quote(str(query))}&src=typed_query&f=top"
    else:
        url = f"https://x.com/{handle}"
    result = {"handle": handle, "query": query or "", "url": url, "loggedIn": False,
              "via": "search" if searching else "profile", "tweets": [], "warning": ""}

    with sync_playwright() as p:
        ctx = launch(p, headless=headless)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        try:
            result["loggedIn"] = logged_in(ctx)
            save_state(result["loggedIn"])

            gql = {"tweets": 0, "errors": []}

            def on_resp(r):
                try:
                    if "UserTweets" in r.url or "UserMedia" in r.url:
                        gql["tweets"] = r.status
                    elif ("graphql" in r.url or "/i/api/" in r.url) and r.status >= 400:
                        gql["errors"].append(f"{r.status} {r.url.split('/')[-1].split('?')[0]}")
                except Exception:
                    pass

            page.on("response", on_resp)
            page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)

            got = wait_for_tweet(page, timeout_ms)

            # 備援：個人頁的 UserTweets 有時候整個不發請求，
            # 但搜尋頁走的是另一個端點（SearchTimeline），換一條路常常還通。
            if not got and not searching:
                log("個人頁讀不到，改走搜尋頁再試一次")
                result["via"] = "search"
                search = (f"https://x.com/search?q=from%3A{handle}"
                          f"&src=typed_query&f=live")
                try:
                    page.goto(search, wait_until="domcontentloaded", timeout=timeout_ms)
                    got = wait_for_tweet(page, timeout_ms)
                except Exception as e:
                    log("搜尋頁也失敗", e)

            if not got:
                if searching:
                    out({**result, "error": "search_not_found",
                         "message": "搜尋頁沒有結果，或這個登入 session 被限流了。"}, 1)
                if not result["loggedIn"]:
                    hint = "讀不到時間軸，目前未登入。"
                elif gql["tweets"] and gql["tweets"] >= 400:
                    hint = f"X 回應時間軸時出錯（HTTP {gql['tweets']}）。可能是帳號被保護或限流。"
                elif not gql["tweets"]:
                    hint = ("個人頁與搜尋頁都讀不到推文，X 沒有發出取推文列表的請求。"
                            "多半是這個登入 session 被限流了，隔一段時間再試；"
                            "若持續如此，用瀏覽器手動開一次該帳號頁面確認帳號本身正常。")
                else:
                    hint = "X 回了推文資料但畫面沒渲染出來，稍後再試。"
                out({**result, "error": "timeline_not_found", "message": hint}, 1)

            # 時間軸是虛擬列表，捲幾次才載得到足夠的則數
            for _ in range(3):
                page.mouse.wheel(0, 1600)
                page.wait_for_timeout(900)

            seen_ids = set()
            for art in page.locator(ANY_ARTICLE).all():
                if len(result["tweets"]) >= limit:
                    break
                try:
                    full = art.inner_text(timeout=2000)
                except Exception:
                    continue

                status_href = ""
                try:
                    for a in art.locator('a[href*="/status/"]').all():
                        h = a.get_attribute("href") or ""
                        if "/status/" in h and "/analytics" not in h and "/photo/" not in h:
                            status_href = h
                            break
                except Exception:
                    pass
                sid = ""
                m = re.search(r"/status/(\d+)", status_href or "")
                if m:
                    sid = m.group(1)
                if not sid or sid in seen_ids:
                    continue
                seen_ids.add(sid)

                text = ""
                try:
                    parts = art.locator(TEXT_SEL).all_inner_texts()
                    text = "\n\n".join(t.strip() for t in parts if t.strip())
                except Exception:
                    pass

                posted = ""
                try:
                    posted = art.locator("time").first.get_attribute("datetime") or ""
                except Exception:
                    pass

                images = []
                try:
                    for img in art.locator('img[src*="pbs.twimg.com/media"]').all():
                        src = img.get_attribute("src") or ""
                        if src:
                            u = upgrade_media(src)
                            if u not in images:
                                images.append(u)
                except Exception:
                    pass

                links = []
                try:
                    for a in art.locator("a[href]").all():
                        href = a.get_attribute("href") or ""
                        low = href.lower()
                        if (not href.startswith("http")) or "x.com/" in low or "twitter.com/" in low:
                            continue
                        if href not in [x["url"] for x in links]:
                            lbl = ""
                            try:
                                lbl = " ".join((a.inner_text(timeout=800) or "").split())
                            except Exception:
                                pass
                            links.append({"url": href, "label": lbl})
                except Exception:
                    pass

                # 搜尋頁可能混進別人的推文，用網址裡的帳號再確認一次
                who = handle
                if searching:
                    mh = re.search(r"/([A-Za-z0-9_]{1,15})/status/", status_href or "")
                    if not mh:
                        continue
                    who = mh.group(1)
                elif f"/{handle.lower()}/status/" not in (status_href or "").lower():
                    continue

                result["tweets"].append({
                    "id": sid,
                    "handle": who,
                    "url": f"https://x.com/{who}/status/{sid}",
                    "text": text,
                    "postedAt": posted,
                    "images": images,
                    "links": links,
                    "metrics": read_metrics(art),
                    "isRepost": any(k in full for k in _REPOST_MARKS),
                    "isReply": any(k in full for k in _REPLY_MARKS),
                    "isPinned": any(k in full for k in _PINNED_MARKS),
                })

            if not result["tweets"]:
                result["warning"] = "時間軸有渲染，但一則推文都沒解析出來"
            elif not any(any(t["metrics"].values()) for t in result["tweets"]):
                result["warning"] = "抓到推文但互動數全是 0，計分會少一項"
        finally:
            try:
                ctx.close()
            except Exception:
                pass

    out(result)


def cmd_download(urls, images_dir):
    """用已登入的 context 下載圖片，給 pbs.twimg.com 直連失敗時當備援"""
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
                    ext = ".png" if "format=png" in src else ".jpg"
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
    ap = argparse.ArgumentParser(description="用 Playwright 讀 X／Twitter 貼文")
    ap.add_argument("--url")
    ap.add_argument("--images-dir")
    ap.add_argument("--login", action="store_true")
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--headful", action="store_true", help="抓取時也開有頭瀏覽器，除錯用")
    ap.add_argument("--timeout", type=int, default=45000)
    ap.add_argument("--download", action="append", default=[], help="要下載的圖片網址，可重複")
    ap.add_argument("--timeline", help="讀這個帳號的時間軸（不含 @）")
    ap.add_argument("--search", help="用關鍵字搜熱門推文（收錄時找圖用）")
    ap.add_argument("--limit", type=int, default=10, help="時間軸最多讀幾則")
    a = ap.parse_args()

    if a.status:
        cmd_status()
    if a.login:
        cmd_login()
    if a.download:
        if not a.images_dir:
            out({"error": "no_images_dir", "message": "--download 需要搭配 --images-dir"}, 2)
        cmd_download(a.download, a.images_dir)
    if a.search:
        cmd_timeline("", max(1, min(a.limit, 40)), a.timeout,
                     headless=not a.headful, query=a.search)
    if a.timeline:
        cmd_timeline(a.timeline, max(1, min(a.limit, 40)), a.timeout, headless=not a.headful)
    if not a.url:
        out({"error": "no_url", "message": "要給 --url，或用 --login／--status"}, 2)
    cmd_scrape(a.url, a.images_dir, headless=not a.headful, timeout_ms=a.timeout)


if __name__ == "__main__":
    main()
