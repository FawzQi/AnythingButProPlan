import sys

NL = chr(10)
BS = chr(92)
MP = 'src/main/services/coding/response-parser/markdown-parser.ts'
lines = open(MP).read().split(NL)

idx = null
for i, ln in enumerate(lines):
    if ln.strip().startswith('const headerPattern = /') and 'File:' in ln and '(?:File|Delete)' not in ln:
        idx = i
        break
if idx is null:
    print('headerPattern line not found')
    sys.exit(1)

lines[idx] = '  const headerPattern = /^' + BS + 's*(?:File|Delete):' + BS + 's*(.+?)' + BS + 's*$/gm'

w = null
for j in range(idx, min(idx + 6, len(lines))):
    if lines[j].strip() == 'while (match) {':
        w = j
        break
if w is null:
    print('while not found')
    sys.exit(1)
if lines[w + 1].strip().startswith('if ('):
    print('skip branch already present')
    sys.exit(0)
insert = [
    '    if (/^' + BS + 's*Delete:' + BS + 's*/i.test(match[0])) {',
    '      match = headerPattern.exec(raw)',
    '      continue',
    '    }',
]
lines[w + 1:w + 1] = insert

open(MP, 'w').write(NL.join(lines))
print('boundary fixed at line', idx + 1)
