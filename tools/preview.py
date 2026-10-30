"""把一則貼文或素材算成一頁 HTML 預覽，給手機上看。

用途：從手機用 Claude Code 下指令做完事之後，回傳一個看得舒服的結果頁
（發佈成 Artifact），而不是在對話裡貼一大段純文字。

  py tools/preview.py post <貼文id>
  py tools/preview.py material <素材id>
  py tools/preview.py post <貼文id> --out C:/tmp/x.html

版面固定寫在這裡，內容每次從 data/ 讀 —— 所以每次只換內容，不重寫網頁。

貼文預覽是可以直接改的：頁面把改動存進 Artifact 的 db，Claude 再用
read_db 拉回來寫進 variants/*.md。頁面碰不到本機（沙盒），db 是唯一的橋。

直接讀檔不打 API：這樣 dev server 沒開也產得出來，而且不會因為端點改動就壞。
圖片一定要嵌成 data URI，Artifact 的沙盒連不到本機的 localhost。
"""

import base64
import html
import io
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')

PLAT_NAME = {'facebook': 'Facebook', 'instagram': 'Instagram', 'threads': 'Threads', 'x': 'X'}
# 只有平台真的會擋的才寫在這裡，寫建議值會讓畫面上出現假的紅字
PLAT_LIMIT = {'threads': 500, 'instagram': 2200, 'x': 280}

# Artifact 上限 16MB，base64 會膨脹三分之一，留一點餘裕
MAX_EMBED_BYTES = 6 * 1024 * 1024
MAX_IMAGES = 6


def esc(s):
    return html.escape(str(s if s is not None else ''), quote=True)


def read_json(path, default=None):
    try:
        return json.load(io.open(path, encoding='utf-8'))
    except Exception:
        return default if default is not None else {}


def read_variants(post_dir):
    """讀 variants/*.md。格式是 --- frontmatter --- 之後接內文"""
    vdir = os.path.join(post_dir, 'variants')
    if not os.path.isdir(vdir):
        return []
    out = []
    for name in sorted(os.listdir(vdir)):
        if not name.endswith('.md'):
            continue
        raw = io.open(os.path.join(vdir, name), encoding='utf-8').read()
        meta, body = {}, raw
        if raw.startswith('---'):
            parts = raw.split('---', 2)
            if len(parts) == 3:
                for line in parts[1].strip().split('\n'):
                    if ':' in line:
                        k, v = line.split(':', 1)
                        meta[k.strip()] = v.strip()
                body = parts[2].lstrip('\n')
        meta['body'] = body.rstrip()
        out.append(meta)
    return out


def embed_images(img_dir, files):
    """把圖片轉成 data URI。太大或太多就跳過，並回報跳掉幾張"""
    embedded, skipped, used = [], 0, 0
    for f in files[:MAX_IMAGES]:
        p = os.path.join(img_dir, f)
        try:
            size = os.path.getsize(p)
        except OSError:
            continue
        if used + size > MAX_EMBED_BYTES:
            skipped += 1
            continue
        ext = os.path.splitext(f)[1].lower()
        mime = {'.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif'}.get(ext, 'image/jpeg')
        data = base64.b64encode(io.open(p, 'rb').read()).decode('ascii')
        embedded.append(f'data:{mime};base64,{data}')
        used += size
    skipped += max(0, len(files) - MAX_IMAGES)
    return embedded, skipped


CSS = '''
:root {
  --bg: #f3f4f7; --panel: #fff; --panel-2: #eceef3; --line: #dde0e8;
  --ink: #1c2130; --muted: #5b6274; --faint: #8b91a3;
  --accent: #d9722f; --accent-soft: #fbe8d9;
  --ok: #2f8f5b; --ok-soft: #e6f4ec; --warn: #a5680f; --warn-soft: #fbeed6;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #14161c; --panel: #1b1e27; --panel-2: #232733; --line: #2e323f;
    --ink: #e8eaf0; --muted: #9aa0b4; --faint: #6b7186;
    --accent: #ef9257; --accent-soft: #3a2a1c;
    --ok: #63c48d; --ok-soft: #1c2f24; --warn: #e0ac52; --warn-soft: #362a15;
  }
}
:root[data-theme="dark"] {
  --bg: #14161c; --panel: #1b1e27; --panel-2: #232733; --line: #2e323f;
  --ink: #e8eaf0; --muted: #9aa0b4; --faint: #6b7186;
  --accent: #ef9257; --accent-soft: #3a2a1c;
  --ok: #63c48d; --ok-soft: #1c2f24; --warn: #e0ac52; --warn-soft: #362a15;
}
* { box-sizing: border-box; }
body {
  background: var(--bg); color: var(--ink);
  font: 15px/1.7 "Noto Sans TC", "PingFang TC", "Microsoft JhengHei",
        -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.wrap { max-width: 640px; margin: 0 auto; padding: 22px 18px 40px; }
.hero { border-radius: 14px; overflow: hidden; box-shadow: 0 1px 2px rgba(0,0,0,.06), 0 8px 24px rgba(0,0,0,.10); }
.hero img { display: block; width: 100%; height: auto; }
.gallery { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-top: 6px; }
.gallery img { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 8px; display: block; }
h1 { font-size: 20px; margin: 18px 0 4px; letter-spacing: .01em; text-wrap: balance; }
.sub { color: var(--muted); font-size: 13px; margin: 0 0 16px; }
.chips { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 18px; align-items: center; }
.chip { font-size: 12px; padding: 4px 10px; border-radius: 20px; background: var(--panel-2); color: var(--muted); }
.chip.warn { background: var(--warn-soft); color: var(--warn); }
.chip.ok { background: var(--ok-soft); color: var(--ok); }
.linkchip {
  display: inline-block; font-size: 12px; padding: 4px 10px; border-radius: 20px;
  background: var(--accent-soft); color: var(--accent); text-decoration: none;
}
details.origin {
  background: var(--panel-2); border-radius: 10px; padding: 10px 14px; margin-bottom: 20px;
  color: var(--muted); font-size: 13px;
}
details.origin summary { cursor: pointer; color: var(--ink); font-weight: 600; }
details.origin p { margin: 8px 0 0; white-space: pre-wrap; }
.variants { display: flex; flex-direction: column; gap: 12px; }
.variant { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
.variant summary { cursor: pointer; list-style: none; display: flex; align-items: center; gap: 10px; font-size: 13px; }
.variant summary::-webkit-details-marker { display: none; }
.plat { font-weight: 700; font-size: 12px; padding: 3px 9px; border-radius: 6px; color: #fff; white-space: nowrap; }
.plat-facebook { background: #4267B2; }
.plat-instagram { background: linear-gradient(135deg,#d6249f,#fa7e1e); }
.plat-threads { background: #1c1f27; }
.plat-x { background: #1c1f27; }
.vlabel { color: var(--muted); min-width: 0; }
.spacer { flex: 1; }
.count { font-variant-numeric: tabular-nums; color: var(--faint); font-size: 12px; white-space: nowrap; }
.count.over { color: var(--warn); font-weight: 700; }
.body { margin: 12px 0 8px; white-space: pre-wrap; line-height: 1.75; font-size: 14.5px; }
.note { margin: 0; color: var(--faint); font-size: 12px; border-top: 1px dashed var(--line); padding-top: 8px; }
.published { background: var(--ok-soft); color: var(--ok); border-radius: 10px; padding: 10px 14px; font-size: 13px; margin-bottom: 18px; }
.published a { color: var(--ok); }
.vhead { display: flex; align-items: center; gap: 10px; font-size: 13px; }
.editbtn {
  border: 1px solid var(--line); background: var(--panel-2); color: var(--muted);
  border-radius: 6px; padding: 3px 10px; font-size: 12px; cursor: pointer; font: inherit;
  font-size: 12px; line-height: 1.5;
}
.editbtn:hover { color: var(--ink); }
.editbtn[hidden] { display: none !important; }
textarea.body {
  width: 100%; min-height: 120px; resize: vertical;
  background: var(--bg); color: var(--ink);
  border: 1px solid var(--accent); border-radius: 8px; padding: 10px 12px;
  font: inherit; font-size: 14.5px; line-height: 1.75;
}
.savebar {
  position: sticky; bottom: 0; margin-top: 16px; padding: 12px 14px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
  display: flex; align-items: center; gap: 10px; font-size: 13px;
  box-shadow: 0 -2px 16px rgba(0,0,0,.10);
}
.savebar button {
  border: none; background: var(--accent); color: #fff; font: inherit; font-size: 13px;
  font-weight: 600; border-radius: 8px; padding: 8px 16px; cursor: pointer;
}
.savebar button:disabled { opacity: .45; cursor: not-allowed; }
.savestate { color: var(--muted); flex: 1; min-width: 0; }
.savestate.ok { color: var(--ok); }
.savestate.bad { color: var(--warn); }
footer { margin-top: 26px; color: var(--faint); font-size: 11.5px; line-height: 1.8; border-top: 1px solid var(--line); padding-top: 12px; }
'''


EDIT_SCRIPT = """
<div class="savebar" id="savebar" hidden>
  <span class="savestate" id="savestate">改好之後按儲存，再回訊息告訴我，我把它寫回本機</span>
  <button id="savebtn" disabled>儲存修改</button>
</div>
<script>
(function () {
  var POST_ID = %POST_ID%;
  var bar = document.getElementById('savebar');
  var state = document.getElementById('savestate');
  var btn = document.getElementById('savebtn');
  var dirty = false;
  var db = null;

  function bodies() {
    return Array.prototype.slice.call(document.querySelectorAll('.variant[data-vid]'));
  }

  function say(msg, cls) {
    state.textContent = msg;
    state.className = 'savestate' + (cls ? ' ' + cls : '');
  }

  function recount(box) {
    var ta = box.querySelector('textarea.body');
    var el = box.querySelector('.count');
    var limit = Number(box.getAttribute('data-limit')) || 0;
    var n = Array.from(ta.value).length;
    el.textContent = n + ' 字' + (limit ? ' / 上限 ' + limit : '');
    el.className = 'count' + (limit && n > limit ? ' over' : '');
  }

  function grow(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.max(120, ta.scrollHeight + 4) + 'px';
  }

  bodies().forEach(function (box) {
    var para = box.querySelector('p.body');
    var ta = box.querySelector('textarea.body');
    var original = ta.value;
    var bEdit = box.querySelector('[data-act=edit]');
    var bDone = box.querySelector('[data-act=done]');
    var bReset = box.querySelector('[data-act=reset]');

    function mode(editing) {
      para.hidden = editing;
      ta.hidden = !editing;
      bEdit.hidden = editing;
      bDone.hidden = !editing;
      bReset.hidden = !editing || ta.value === original;
      if (editing) { grow(ta); ta.focus(); }
    }

    bEdit.addEventListener('click', function (e) { e.preventDefault(); mode(true); });
    bDone.addEventListener('click', function (e) {
      e.preventDefault();
      para.textContent = ta.value;
      mode(false);
    });
    bReset.addEventListener('click', function (e) {
      e.preventDefault();
      ta.value = original;
      para.textContent = original;
      recount(box);
      mode(true);
      markDirty();
    });
    ta.addEventListener('input', function () {
      grow(ta);
      recount(box);
      bReset.hidden = ta.value === original;
      markDirty();
    });
    // summary 裡的按鈕會觸發 details 開合，擋掉
    box.querySelector('summary').addEventListener('click', function (e) {
      if (e.target.closest('.editbtn')) e.preventDefault();
    });
  });

  function markDirty() {
    dirty = true;
    if (db) { btn.disabled = false; say('有未儲存的修改'); }
  }

  function collect() {
    var out = {};
    bodies().forEach(function (box) {
      out[box.getAttribute('data-vid')] = box.querySelector('textarea.body').value;
    });
    return out;
  }

  btn.addEventListener('click', function () {
    if (!db) return;
    btn.disabled = true;
    say('儲存中…');
    db.doc('edits/current').set({
      postId: POST_ID,
      variants: collect(),
      savedAt: new Date().toISOString()
    }).then(function () {
      dirty = false;
      say('已儲存。回訊息跟我說一聲，我把它寫回本機的貼文檔', 'ok');
    }).catch(function (e) {
      btn.disabled = false;
      var code = (e && e.code) || 'unknown';
      say(code === 'not_granted'
        ? '這個檢視沒有寫入權限，改用複製貼上給我'
        : '存不起來（' + code + '），改用複製貼上給我', 'bad');
    });
  });

  window.addEventListener('beforeunload', function (e) {
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  // 能力是後到的，先把頁面當唯讀渲染，等它回來才點亮編輯
  if (!window.claude || !window.claude.use) return;
  window.claude.use('db').then(function (ns) {
    if (!ns) { say('這個檢視不能存檔，改完用複製貼上給我', 'bad'); bar.hidden = false; return; }
    db = ns;
    bar.hidden = false;
    bodies().forEach(function (box) { box.querySelector('[data-act=edit]').hidden = false; });
    return db.doc('edits/current').get().then(function (snap) {
      if (!snap.exists) return;
      var d = snap.data() || {};
      if (d.postId !== POST_ID) return;
      var saved = d.variants || {};
      var n = 0;
      bodies().forEach(function (box) {
        var vid = box.getAttribute('data-vid');
        if (typeof saved[vid] !== 'string') return;
        var ta = box.querySelector('textarea.body');
        if (saved[vid] === ta.value) return;
        ta.value = saved[vid];
        box.querySelector('p.body').textContent = saved[vid];
        box.querySelector('[data-act=reset]').hidden = false;
        recount(box);
        n++;
      });
      if (n) say('顯示的是你上次存的修改（' + n + ' 版），還沒寫回本機', 'ok');
    });
  }).catch(function () {
    say('能力載入失敗，改完用複製貼上給我', 'bad');
  });
})();
</script>
"""


def render(title, hero, gallery, heading, sub, chips, origin_label, origin_text,
           blocks, footer, script=''):
    gal = ''
    if gallery:
        gal = '<div class="gallery">' + ''.join(
            f'<img src="{g}" alt="">' for g in gallery
        ) + '</div>'
    origin = ''
    if origin_text:
        origin = (
            f'<details class="origin"><summary>{esc(origin_label)}</summary>'
            f'<p>{esc(origin_text)}</p></details>'
        )
    return f'''<title>{esc(title)}</title>
<style>{CSS}</style>

<div class="wrap">
  {f'<div class="hero"><img src="{hero}" alt=""></div>' if hero else ''}
  {gal}
  <h1>{esc(heading)}</h1>
  <p class="sub">{sub}</p>
  <div class="chips">{chips}</div>
  {origin}
  <div class="variants">{blocks}</div>
  <footer>{footer}</footer>
</div>
{script}
'''


def build_post(pid):
    pdir = os.path.join(DATA, 'posts', pid)
    post = read_json(os.path.join(pdir, 'post.json'))
    if not post:
        raise SystemExit('找不到貼文：' + pid)

    files = [i['file'] for i in post.get('images', []) if i.get('selected')]
    imgs, skipped = embed_images(os.path.join(pdir, 'images'), files)

    missing = post.get('missing') or []
    chips = [
        f'<span class="chip warn">待補：{esc("、".join(missing))}</span>' if missing
        else '<span class="chip ok">資訊完整</span>'
    ]
    for l in post.get('links', []):
        if l.get('url'):
            chips.append(
                f'<a class="linkchip" href="{esc(l["url"])}" target="_blank" '
                f'rel="noopener">{esc(l.get("label") or "連結")} ↗</a>'
            )
    if skipped:
        chips.append(f'<span class="chip">另有 {skipped} 張圖沒放進預覽</span>')

    blocks = []
    for v in read_variants(pdir):
        plat = v.get('platform', '')
        body = v.get('body', '')
        n = len(body)
        limit = PLAT_LIMIT.get(plat)
        over = limit is not None and n > limit
        count = f'{n} 字' + (f' / 上限 {limit}' if limit else '')
        vid = esc(v.get('id') or '')
        blocks.append(f'''
      <details class="variant" open data-vid="{vid}" data-limit="{limit or 0}">
        <summary class="vhead">
          <span class="plat plat-{esc(plat)}">{esc(PLAT_NAME.get(plat, plat))}</span>
          <span class="vlabel">{esc(v.get("label"))}</span>
          <span class="spacer"></span>
          <span class="count{' over' if over else ''}">{esc(count)}</span>
        </summary>
        <p class="body">{esc(body)}</p>
        <textarea class="body" hidden>{esc(body)}</textarea>
        <div class="vhead" style="margin-bottom:6px">
          <button class="editbtn" data-act="edit" hidden>編輯</button>
          <button class="editbtn" data-act="done" hidden>完成</button>
          <button class="editbtn" data-act="reset" hidden>還原</button>
        </div>
        {f'<p class="note">{esc(v.get("note"))}</p>' if v.get('note') else ''}
      </details>''')

    recs = post.get('publishRecords') or []
    if recs:
        lines = []
        for r in recs:
            name = PLAT_NAME.get(r.get('platform'), r.get('platform'))
            when = str(r.get('at', ''))[:16].replace('T', ' ')
            link = (f' · <a href="{esc(r["url"])}" target="_blank" rel="noopener">開啟 ↗</a>'
                    if r.get('url') else '')
            lines.append(f'{esc(name)} · {esc(when)}{link}')
        published = '<div class="published">已發佈：' + '　'.join(lines) + '</div>'
        blocks.insert(0, published)
        foot_tail = ''
    else:
        foot_tail = ' · 尚未發佈'

    # 合併撰寫的貼文有多則來源，逐一列出；舊資料沒有 sources 就用 sourceName
    sources = post.get('sources') or []
    if len(sources) > 1:
        names = [s.get('sourceName') or s.get('title') or '本地素材' for s in sources]
        src = f'{esc("、".join(names))}（合併 {len(sources)} 則）'
    else:
        src = esc(post.get('sourceName') or '—')
    sub = f'來源：{src}　·　{esc(post.get("category"))}／{esc(post.get("postType"))}'

    return render(
        title=post.get('title') or pid,
        hero=imgs[0] if imgs else '',
        gallery=imgs[1:],
        heading=post.get('title') or pid,
        sub=sub,
        chips=''.join(chips),
        origin_label='原始素材內容',
        origin_text=post.get('note'),
        blocks=''.join(blocks),
        footer=f'貼文工作台 · {esc(pid)}{foot_tail}',
        script=EDIT_SCRIPT.replace('%POST_ID%', json.dumps(pid, ensure_ascii=False))
    )


def build_material(mid):
    mdir = os.path.join(DATA, 'inbox', mid)
    m = read_json(os.path.join(mdir, 'material.json'))
    if not m:
        raise SystemExit('找不到素材：' + mid)

    imgs, skipped = embed_images(os.path.join(mdir, 'images'), m.get('images', []))

    chips = []
    if m.get('written'):
        chips.append('<span class="chip ok">已撰寫</span>')
    else:
        chips.append('<span class="chip">尚未撰寫</span>')
    chips.append(f'<span class="chip">{esc(m.get("via") or "manual")}</span>')
    for l in m.get('links', []):
        if l.get('url'):
            chips.append(
                f'<a class="linkchip" href="{esc(l["url"])}" target="_blank" '
                f'rel="noopener">{esc(l.get("label") or "連結")} ↗</a>'
            )
    if m.get('warning'):
        chips.append(f'<span class="chip warn">{esc(m["warning"])}</span>')
    if skipped:
        chips.append(f'<span class="chip">另有 {skipped} 張圖沒放進預覽</span>')

    body = f'''
      <details class="variant" open>
        <summary>
          <span class="plat plat-facebook">原文</span>
          <span class="vlabel">{esc(m.get("sourceGuess") or "")}</span>
          <span class="spacer"></span>
          <span class="count">{len(m.get("text") or "")} 字</span>
        </summary>
        <p class="body">{esc(m.get("text"))}</p>
      </details>'''

    return render(
        title=m.get('title') or mid,
        hero=imgs[0] if imgs else '',
        gallery=imgs[1:],
        heading=m.get('title') or mid,
        sub=f'素材 · {esc(len(m.get("images", [])))} 張圖',
        chips=''.join(chips),
        origin_label='',
        origin_text='',
        blocks=body,
        footer=f'貼文工作台 · 素材 {esc(mid)}'
    )


def main():
    args = [a for a in sys.argv[1:]]
    out = None
    if '--out' in args:
        i = args.index('--out')
        out = args[i + 1]
        del args[i:i + 2]
    if len(args) < 2:
        raise SystemExit(__doc__)

    kind, ident = args[0], args[1]
    html_out = build_post(ident) if kind == 'post' else build_material(ident)

    out = out or os.path.join(ROOT, 'data', 'preview.html')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    io.open(out, 'w', encoding='utf-8', newline='\n').write(html_out)
    print(out)
    print(f'{len(html_out)} bytes')


if __name__ == '__main__':
    main()
