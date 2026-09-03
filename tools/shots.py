"""替 README 拍工具的畫面截圖。

  py tools/shots.py            # 拍全部，存到 docs/
  py tools/shots.py discover   # 只拍某一頁

用乾淨的 Chromium（不是抓推特那份 profile），所以不會動到登入狀態，
也不會佔用那份 profile 的鎖。

刻意不拍設定頁 —— 那頁有粉專名稱、帳號 ID 這些不該進公開版本庫的東西。
"""

import os
import sys

BASE = 'http://localhost:4321'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'docs')

# name, path, 等哪個元素出現才拍（避免拍到還沒 render 完的畫面）, 視窗高度
#
# 高度是刻意設的：畫面上是真實資料，往下捲會出現成人向遊戲的宣傳圖，
# 那個不該進公開版本庫。裁到只留上半部，版面一樣看得清楚。
SHOTS = [
    ('discover', '/discover', '.cols3', 900),
    ('inbox', '/inbox', '.mgrid, .empty', 706),
    ('posts', '/', '.page', 900),
]


def main():
    from playwright.sync_api import sync_playwright

    want = sys.argv[1] if len(sys.argv) > 1 else ''
    shots = [s for s in SHOTS if not want or s[0] == want]
    if not shots:
        raise SystemExit('沒有這一頁：' + want)

    os.makedirs(OUT, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(
            viewport={'width': 1440, 'height': 900},  # 每張再各自調整
            device_scale_factor=2,          # 2x 才不會在 GitHub 上糊掉
            color_scheme='dark',
            locale='zh-TW'
        )
        page = ctx.new_page()

        for name, path, wait_for, height in shots:
            page.set_viewport_size({'width': 1440, 'height': height})
            page.goto(BASE + path, wait_until='networkidle', timeout=60000)
            try:
                page.wait_for_selector(wait_for, timeout=15000)
            except Exception:
                print(f'  {name}: 等不到 {wait_for}，還是照拍')
            page.wait_for_timeout(1200)      # 讓圖片與字體載完
            dest = os.path.join(OUT, name + '.png')
            page.screenshot(path=dest)
            print(f'  {name} → {dest} ({os.path.getsize(dest) // 1024} KB)')

        browser.close()


if __name__ == '__main__':
    main()
