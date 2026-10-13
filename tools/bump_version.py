"""Поднять версию Mini App: python3 tools/bump_version.py

Telegram держит JS и CSS в кэше. Версия стоит в трёх местах: в ссылках на
файлы в index.html (?v=…), в APP_VERSION в app.js и в version.json. При
запуске приложение сверяет свою версию с version.json и, если вышла новая,
перезагружается с новой меткой — кэш обходится сам.
"""
import json, os, re, time

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
v = time.strftime("%Y%m%d.%H%M")

p = os.path.join(root, "index.html")
s = open(p, encoding="utf-8").read()
s = re.sub(r'(assets/(?:css|js)/[\w.-]+\.(?:css|js))(\?v=[\w.]+)?', rf'\1?v={v}', s)
open(p, "w", encoding="utf-8").write(s)

p = os.path.join(root, "assets/js/app.js")
s = open(p, encoding="utf-8").read()
s, n = re.subn(r"const APP_VERSION = '[\w.]+';", f"const APP_VERSION = '{v}';", s)
assert n == 1, "в app.js нет APP_VERSION"
open(p, "w", encoding="utf-8").write(s)

json.dump({"v": v}, open(os.path.join(root, "version.json"), "w"))
print("версия", v)
