"""Собрать Edge Function в один файл: python3 tools/bundle_api.py

Редактор Supabase в браузере принимает один файл, поэтому ics.ts
встраивается в index.ts → supabase/functions/api/index.bundled.ts.
"""
import os, re

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
d = os.path.join(root, "supabase", "functions", "api")
idx = open(os.path.join(d, "index.ts"), encoding="utf-8").read()
ics = re.sub(r"^export ", "", open(os.path.join(d, "ics.ts"), encoding="utf-8").read(), flags=re.M)
line = 'import { icsCalendar, type IcsShift } from "./ics.ts";\n'
assert line in idx, "в index.ts нет импорта ics.ts"
out = ("// СБОРКА для вставки в редактор Supabase (index.ts + ics.ts). Генерируется из соседних файлов.\n"
       + idx.replace(line, "// ── ics.ts встроен сюда: редактор Supabase в браузере принимает один файл ──\n" + ics + "\n"))
open(os.path.join(d, "index.bundled.ts"), "w", encoding="utf-8").write(out)
print("собрано", os.path.relpath(os.path.join(d, "index.bundled.ts"), root))
