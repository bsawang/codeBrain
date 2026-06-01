// Generate test-data-30.json — 30 matching tests + 4 success tests
const {preprocess, extractErrorCode} = require('./dist/core/preprocessor.js');

const TESTS = [
  // —— Seed: 首次出现，均 miss ——
  {id:1,  phase:'seed',   name:'ESLint 缺模块 (npx)',                              cmd:'npx eslint src/',                  out:"Error: Cannot find module 'eslint-plugin-react'\nRequire stack:\n- /app/node_modules/.bin/eslint.js:1:1"},
  {id:2,  phase:'seed',   name:'npm 缺模块 (ERR 码)',                               cmd:'npm install',                      out:"npm ERR! code MODULE_NOT_FOUND\nnpm ERR! Cannot find module 'lodash'"},
  {id:3,  phase:'seed',   name:'Node 重复发 HTTP 头 (ERR_HTTP_HEADERS_SENT)',       cmd:'node server.js',                   out:"Error [ERR_HTTP_HEADERS_SENT]: Cannot set headers after they are sent to the client\n    at ServerResponse.setHeader (_http_outgoing.js:518:11)"},
  {id:4,  phase:'seed',   name:'Null 属性访问 (name)',                               cmd:'npm run dev',                      out:"TypeError: Cannot read properties of null (reading 'name')\n    at Home (src/pages/Home.tsx:12:17)"},
  {id:5,  phase:'seed',   name:'TS2322 缺属性类型',                                  cmd:'npx tsc --noEmit',                 out:"src/Modal.tsx:45:7 - error TS2322: Type '{ children: string; }' is not assignable to type 'IntrinsicAttributes & ModalProps'.\n  Property 'isOpen' is missing in type 'ModalProps'."},
  {id:6,  phase:'seed',   name:'TS2304 cannot find name',                           cmd:'npx tsc --noEmit',                 out:"src/app.tsx:10:5 - error TS2304: Cannot find name 'something'."},
  {id:7,  phase:'seed',   name:'TS2554 参数数量错误',                                cmd:'npx tsc --noEmit',                 out:"src/utils.ts:3:18 - error TS2554: Expected 2 arguments, but got 1."},
  {id:8,  phase:'seed',   name:'JSON 语法错误',                                     cmd:'npm run dev',                      out:"SyntaxError: Unexpected token '<' in JSON at position 42"},
  {id:9,  phase:'seed',   name:'Git push 被拒 (main)',                              cmd:'git push origin main',            out:"! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs to 'https://github.com/user/repo.git'"},
  {id:10, phase:'seed',   name:'Git merge 冲突',                                    cmd:'git merge feature/login',         out:"CONFLICT (content): Merge conflict in src/index.ts\nAutomatic merge failed; fix conflicts and then commit."},
  {id:11, phase:'seed',   name:'Docker 端口占用 (3000)',                             cmd:'docker run -p 3000:3000 app',     out:"docker: Error response from daemon: driver failed programming external connectivity on endpoint app: Error starting userland proxy: listen tcp 0.0.0.0:3000: bind: address already in use."},
  {id:12, phase:'seed',   name:'EADDRINUSE 端口 3000',                               cmd:'node server.js',                   out:"Error: listen EADDRINUSE: address already in use :::3000"},
  {id:13, phase:'seed',   name:'ENOENT config.json',                                cmd:'node script.js',                   out:"Error: ENOENT: no such file or directory, open '/app/config/config.json'"},
  {id:14, phase:'seed',   name:'EACCES app.log',                                    cmd:'node app.js',                      out:"Error: EACCES: permission denied, access '/var/log/app.log'"},
  {id:15, phase:'seed',   name:'ESLint 引号规则',                                    cmd:'npx eslint src/',                  out:"/app/src/App.tsx:5:3 - Strings must use doublequote. (quotes)"},
  {id:16, phase:'seed',   name:'npm ELIFECYCLE',                                    cmd:'npm run start',                    out:"npm ERR! code ELIFECYCLE\nnpm ERR! errno 1\nnpm ERR! app@1.0.0 start: `node index.js`\nnpm ERR! Exit status 1"},
  {id:17, phase:'seed',   name:'Python import 缺模块',                               cmd:'python app.py',                    out:"Traceback (most recent call last):\n  File \"/app/app.py\", line 1, in <module>\n    import requests\nModuleNotFoundError: No module named 'requests'"},
  {id:18, phase:'seed',   name:'pip 找不到版本',                                     cmd:'pip install requests',             out:"ERROR: Could not find a version that satisfies the requirement requests===2.25.0\nERROR: No matching distribution found for requests===2.25.0"},
  {id:19, phase:'seed',   name:'Docker 容器不存在',                                   cmd:'docker exec -it myapp bash',       out:"Error: No such container: myapp"},
  {id:20, phase:'seed',   name:'Jest 断言失败',                                      cmd:'npx jest',                         out:" FAIL  src/__tests__/App.test.tsx\n  ● App tests › renders\n\n    expect(received).toBe(expected) // Object.is equality\n\n    Expected: 5\n    Received: 3"},

  // —— Verify: 同类重复，均 hit ——
  {id:21, phase:'verify', name:'ESLint 缺别的插件',                                  cmd:'npx eslint src/',                  out:"Error: Cannot find module 'eslint-plugin-prettier'\nRequire stack:\n- /app/node_modules/.bin/eslint.js:1:1"},
  {id:22, phase:'verify', name:'Null 访问 title (同#4)',                             cmd:'npm run dev',                      out:"TypeError: Cannot read properties of null (reading 'title')\n    at Header (src/components/Header.tsx:8:22)"},
  {id:23, phase:'verify', name:'TS2322 类型不符 (同#5)',                             cmd:'npx tsc --noEmit',                 out:"src/utils.ts:10:7 - error TS2322: Type 'boolean' is not assignable to type 'string'."},
  {id:24, phase:'verify', name:'Git push 另一分支 (同#9)',                            cmd:'git push origin feature/login',    out:"! [rejected]        feature/login -> feature/login (non-fast-forward)\nerror: failed to push some refs to 'https://github.com/user/repo.git'"},
  {id:25, phase:'verify', name:'Docker 端口 8080 (同#11)',                           cmd:'docker run -p 8080:80 nginx',      out:"docker: Error response from daemon: driver failed programming external connectivity on endpoint nginx: Error starting userland proxy: listen tcp 0.0.0.0:8080: bind: address already in use."},
  {id:26, phase:'verify', name:'EADDRINUSE 4000 (同#12)',                            cmd:'node server.js',                   out:"Error: listen EADDRINUSE: address already in use :::4000"},
  {id:27, phase:'verify', name:'ENOENT data.json (同#13)',                           cmd:'node script.js',                   out:"Error: ENOENT: no such file or directory, open '/app/data/data.json'"},
  {id:28, phase:'verify', name:'EACCES error.log (同#14)',                           cmd:'node app.js',                      out:"Error: EACCES: permission denied, access '/var/log/nginx/error.log'"},
  {id:29, phase:'verify', name:'Node require 缺 express (同#1)',                     cmd:'node index.js',                    out:"internal/modules/cjs/loader.js:905\n  throw err;\nError: Cannot find module 'express'\nRequire stack:\n- /app/index.js"},
  {id:30, phase:'verify', name:'npm 缺 react (同#2)',                                cmd:'npm install',                      out:"npm ERR! code MODULE_NOT_FOUND\nnpm ERR! Cannot find module 'react'"},

  // —— Success: onSuccess 处理 pending 队列 ——
  {id:31, phase:'success', name:'miss→onSuccess 入库 (Rust 类型错)',                  cmd:'cargo build',                      out:"error[E0308]: mismatched types\n --> src/main.rs:25:5\n  |\n25 |     let x: i32 = \"hello\";\n  |     ^^^^^^^^^^ expected `i32`, found `&str`"},
  {id:32, phase:'success', name:'hit→onSuccess verifiedCount+1 (同#1#21)',          cmd:'npx eslint src/',                  out:"Error: Cannot find module 'eslint-plugin-prettier'\nRequire stack:\n- /app/node_modules/.bin/eslint.js:1:1"},
  {id:33, phase:'success', name:'miss→onSuccess 入库 (ENOTFOUND)',                   cmd:'node server.js',                   out:"Error: getaddrinfo ENOTFOUND api.example.com\n    at GetAddrInfoReqWrap.onlookup [as oncomplete] (dns.js:71:26)"},
  {id:34, phase:'success', name:'hit→onSuccess 批量处理 (同#14)',                     cmd:'node app.js',                      out:"Error: EACCES: permission denied, access '/var/log/app.log'"},
];

// Expected match info + expected injection text + expected classification (recorded baseline)
const MATCH = {
  // seed: 创建的组
  1:  { expectedHit: false, matchBy: '—', seedRef: null, injection: null, classification: { groupId: 'g01', summary: '测试组 g01', category: 'test/mock', hasRule: true } },
  2:  { expectedHit: false, matchBy: '—', seedRef: null, injection: null, classification: { groupId: 'g02', summary: '测试组 g02', category: 'test/mock', hasRule: true } },
  3:  { expectedHit: false, matchBy: '—', seedRef: null, injection: null, classification: { groupId: 'g03', summary: '测试组 g03', category: 'test/mock', hasRule: true } },
  4:  { expectedHit: false, matchBy: '—', seedRef: null, injection: null, classification: { groupId: 'g04', summary: '测试组 g04', category: 'test/mock', hasRule: true } },
  5:  { expectedHit: false, matchBy: '—', seedRef: null, injection: null, classification: { groupId: 'g05', summary: '测试组 g05', category: 'test/mock', hasRule: true } },
  6:  { expectedHit: false, matchBy: '—', seedRef: null, injection: null, classification: { groupId: 'g06', summary: '测试组 g06', category: 'test/mock', hasRule: true } },
  7:  { expectedHit: false, matchBy: '—', seedRef: null, injection: null, classification: { groupId: 'g07', summary: '测试组 g07', category: 'test/mock', hasRule: true } },
  8:  { expectedHit: false, matchBy: '—', seedRef: null, injection: null, classification: { groupId: 'g08', summary: '测试组 g08', category: 'test/mock', hasRule: true } },
  9:  { expectedHit: false, matchBy: '—', seedRef: null, injection: null, classification: { groupId: 'g09', summary: '测试组 g09', category: 'test/mock', hasRule: true } },
  10: { expectedHit: false, matchBy: '—', seedRef: null, injection: null, classification: { groupId: 'g10', summary: '测试组 g10', category: 'test/mock', hasRule: true } },
  11: { expectedHit: false, matchBy: '—', seedRef: null, injection: null, classification: { groupId: 'g11', summary: '测试组 g11', category: 'test/mock', hasRule: true } },
  12: { expectedHit: false, matchBy: '—', seedRef: null, injection: null, classification: { groupId: 'g12', summary: '测试组 g12', category: 'test/mock', hasRule: true } },
  13: { expectedHit: false, matchBy: '—', seedRef: null, injection: null, classification: { groupId: 'g13', summary: '测试组 g13', category: 'test/mock', hasRule: true } },
  14: { expectedHit: false, matchBy: '—', seedRef: null, injection: null, classification: { groupId: 'g14', summary: '测试组 g14', category: 'test/mock', hasRule: true } },
  15: { expectedHit: false, matchBy: '—', seedRef: null, injection: null, classification: { groupId: 'g15', summary: '测试组 g15', category: 'test/mock', hasRule: true } },
  16: { expectedHit: false, matchBy: '—', seedRef: null, injection: null, classification: { groupId: 'g16', summary: '测试组 g16', category: 'test/mock', hasRule: true } },
  17: { expectedHit: false, matchBy: '—', seedRef: null, injection: null, classification: { groupId: 'g17', summary: '测试组 g17', category: 'test/mock', hasRule: true } },
  18: { expectedHit: false, matchBy: '—', seedRef: null, injection: null, classification: { groupId: 'g18', summary: '测试组 g18', category: 'test/mock', hasRule: true } },
  19: { expectedHit: false, matchBy: '—', seedRef: null, injection: null, classification: { groupId: 'g19', summary: '测试组 g19', category: 'test/mock', hasRule: true } },
  20: { expectedHit: false, matchBy: '—', seedRef: null, injection: null, classification: { groupId: 'g20', summary: '测试组 g20', category: 'test/mock', hasRule: true } },
  // verify: 命中的组
  21: { expectedHit: true,  matchBy: "L0 文本",        seedRef: 1, injection: "[codebrain]\n规则: 规则 g01\n触发: 此类错误出现时触发\n验证: 1次", classification: { hitGroup: 'g01', summary: '测试组 g01' } },
  22: { expectedHit: true,  matchBy: "L0 文本",        seedRef: 4, injection: "[codebrain]\n规则: 规则 g04\n触发: 此类错误出现时触发\n验证: 1次", classification: { hitGroup: 'g04', summary: '测试组 g04' } },
  23: { expectedHit: true,  matchBy: "L0 错误码",       seedRef: 5, injection: "[codebrain]\n规则: 规则 g05\n触发: 此类错误出现时触发\n验证: 1次", classification: { hitGroup: 'g05', summary: '测试组 g05' } },
  24: { expectedHit: true,  matchBy: "L0 文本",        seedRef: 9, injection: "[codebrain]\n规则: 规则 g09\n触发: 此类错误出现时触发\n验证: 1次", classification: { hitGroup: 'g09', summary: '测试组 g09' } },
  25: { expectedHit: true,  matchBy: "L1 向量+生态",    seedRef: 11, injection: "[codebrain]\n规则: 规则 g11\n触发: 此类错误出现时触发\n验证: 1次", classification: { hitGroup: 'g11', summary: '测试组 g11' } },
  26: { expectedHit: true,  matchBy: "L0 错误码",       seedRef: 12, injection: "[codebrain]\n规则: 规则 g12\n触发: 此类错误出现时触发\n验证: 1次", classification: { hitGroup: 'g12', summary: '测试组 g12' } },
  27: { expectedHit: true,  matchBy: "L0 错误码",       seedRef: 13, injection: "[codebrain]\n规则: 规则 g13\n触发: 此类错误出现时触发\n验证: 1次", classification: { hitGroup: 'g13', summary: '测试组 g13' } },
  28: { expectedHit: true,  matchBy: "L0 错误码",       seedRef: 14, injection: "[codebrain]\n规则: 规则 g14\n触发: 此类错误出现时触发\n验证: 1次", classification: { hitGroup: 'g14', summary: '测试组 g14' } },
  29: { expectedHit: true,  matchBy: "L1 向量+生态",    seedRef: 1,  injection: "[codebrain]\n规则: 规则 g01\n触发: 此类错误出现时触发\n验证: 2次\n上次未解决", classification: { hitGroup: 'g01', summary: '测试组 g01' } },
  30: { expectedHit: true,  matchBy: "L0 错误码",       seedRef: 2,  injection: "[codebrain]\n规则: 规则 g02\n触发: 此类错误出现时触发\n验证: 1次", classification: { hitGroup: 'g02', summary: '测试组 g02' } },
  // success
  31: { expectedHit: false, matchBy: "miss→onSuccess 入库",            seedRef: null, injection: null, classification: { hitGroup: null } },
  32: { expectedHit: true,  matchBy: "hit→onSuccess verified+1",       seedRef: null, injection: "[codebrain]\n规则: 规则 g01\n触发: 此类错误出现时触发\n验证: 3次\n上次未解决", classification: { hitGroup: 'g01', summary: '测试组 g01' } },
  33: { expectedHit: false, matchBy: "miss→onSuccess 入库",            seedRef: null, injection: null, classification: { hitGroup: null } },
  34: { expectedHit: true,  matchBy: "hit→onSuccess verified+1",       seedRef: null, injection: "[codebrain]\n规则: 规则 g14\n触发: 此类错误出现时触发\n验证: 2次\n上次未解决", classification: { hitGroup: 'g14', summary: '测试组 g14' } },
};

const cases = TESTS.map(t => {
  const norm = preprocess(t.out);
  const code = extractErrorCode(t.out);
  const m = MATCH[t.id] || { expectedHit: false, matchBy: '—', seedRef: null, injection: null, knowledge: null };
  return {
    id: t.id,
    phase: t.phase,
    name: t.name,
    command: t.cmd,
    errorCode: code || null,
    output: t.out,
    normalized: norm,
    expected: {
      hit: m.expectedHit,
      matchBy: m.matchBy,
      seedRef: m.seedRef,
      injection: m.injection,
      knowledge: m.knowledge || null,
    },
  };
});

const dataset = {
  meta: {
    name: 'codebrain-test-data',
    version: '1.1',
    description: '34 条标准测试 — 20 seed + 10 verify + 4 success',
    generated: new Date().toISOString(),
    total: 34,
    seeds: 20,
    verifies: 10,
    successes: 4,
    matchLevels: {
      L0_text: 3,
      L0_errorCode: 5,
      L1_vector: 2,
    },
  },
  cases,
};

const fs = require('fs');
fs.writeFileSync('test-data-30.json', JSON.stringify(dataset, null, 2));
console.log(`Generated ${cases.length} cases (${TESTS.filter(t=>t.phase==='seed').length} seed, ${TESTS.filter(t=>t.phase==='verify').length} verify, ${TESTS.filter(t=>t.phase==='success').length} success)`);
