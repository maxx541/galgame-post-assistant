"""把預覽頁上改好的內容寫回本機的貼文版本檔。

預覽頁（Artifact）碰不到本機，改動是存在 Artifact 的 db 裡。流程：

  1. Claude 用 Artifact 工具的 read_db 把 edits/current 抓下來存成 JSON
  2. py tools/apply_edits.py <貼文id> <那個 json 檔>

只動 variants/*.md 的內文，frontmatter（id/label/platform/locked/note）
原封不動 —— 那些是撰寫時定下來的，不該被一次文字修改洗掉。

寫回去之前會先比對 postId，避免把 A 貼文的修改蓋到 B 貼文上。
"""

import io
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')

PLAT_LIMIT = {'threads': 500, 'instagram': 2200, 'x': 280}


def split_frontmatter(raw):
    """回傳 (frontmatter 原文含前後 ---, 內文)。沒有 frontmatter 就回 ('', 全文)"""
    if not raw.startswith('---'):
        return '', raw
    parts = raw.split('---', 2)
    if len(parts) != 3:
        return '', raw
    return '---' + parts[1] + '---\n', parts[2].lstrip('\n')


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    pid, json_path = sys.argv[1], sys.argv[2]

    payload = json.load(io.open(json_path, encoding='utf-8'))
    # read_db 可能把文件包在外層，兩種形狀都接
    doc = payload.get('data') if isinstance(payload.get('data'), dict) else payload
    doc = doc.get('document') if isinstance(doc.get('document'), dict) else doc

    saved_id = doc.get('postId')
    if saved_id and saved_id != pid:
        raise SystemExit(f'貼文對不上：db 裡是「{saved_id}」，你指定的是「{pid}」')

    variants = doc.get('variants') or {}
    if not variants:
        raise SystemExit('這份 db 文件裡沒有 variants，沒有東西可以套用')

    vdir = os.path.join(DATA, 'posts', pid, 'variants')
    if not os.path.isdir(vdir):
        raise SystemExit('找不到貼文的版本資料夾：' + vdir)

    changed, same, missing = [], [], []
    for vid, body in variants.items():
        path = os.path.join(vdir, vid + '.md')
        if not os.path.exists(path):
            missing.append(vid)
            continue
        raw = io.open(path, encoding='utf-8').read()
        fm, old = split_frontmatter(raw)
        new = str(body).rstrip()
        if new == old.rstrip():
            same.append(vid)
            continue
        io.open(path, 'w', encoding='utf-8', newline='\n').write(fm + new + '\n')

        # 順手回報字數，超過平台上限要讓人知道
        plat = ''
        for line in fm.split('\n'):
            if line.startswith('platform:'):
                plat = line.split(':', 1)[1].strip()
        n = len(new)
        limit = PLAT_LIMIT.get(plat)
        flag = f'  ⚠ 超過 {plat} 上限 {limit}' if limit and n > limit else ''
        changed.append(f'  {vid}（{plat}）{len(old.rstrip())} → {n} 字{flag}')

    print(f'套用到 {pid}')
    if changed:
        print('已更新：')
        print('\n'.join(changed))
    if same:
        print('沒有變動：' + '、'.join(same))
    if missing:
        print('找不到對應的版本檔：' + '、'.join(missing))
    if not changed:
        print('（這次沒有任何內容變動）')


if __name__ == '__main__':
    main()
