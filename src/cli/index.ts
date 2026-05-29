#!/usr/bin/env node
import { StorageEngine } from '../storage/storage-engine';
import { loadConfig } from '../config';

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || '';

  // 无参数 → splash
  if (!command) {
    const { showSplash } = await import('./splash.js');
    showSplash();
    console.log(`  codebrain setup             一键安装`);
    console.log(`  codebrain daemon <start|stop|status>`);
    console.log(`  codebrain <stats|list|show|search|prune>`);
    console.log(`  codebrain hook <register|unregister> <agent>`);
    return;
  }

  // ---- 无状态命令 ----

  if (command === 'daemon') {
    const sub = args[1] || 'start';
    if (sub === 'start') {
      const { startDaemon } = await import('../daemon/server.js');
      const port = await startDaemon();
      console.log(`codebrain daemon: http://127.0.0.1:${port} (pid ${process.pid})`);
      return; // 保持运行
    }
    if (sub === 'stop') {
      const { stopDaemon } = await import('../daemon/server.js');
      stopDaemon();
      return;
    }
    if (sub === 'status') {
      const { getDaemonPort } = await import('../daemon/server.js');
      const port = getDaemonPort();
      console.log(port ? `运行中 (port ${port})` : '未运行');
      return;
    }
    return;
  }

  if (command === 'setup') {
    const { setup } = await import('./setup.js');
    const results = await setup();
    for (const r of results) {
      const icon = r.status === 'ok' ? '✅' : r.status === 'warn' ? '⚠️' : r.status === 'error' ? '❌' : '⏭️';
      console.log(`${icon} ${r.step}: ${r.message}`);
    }
    return;
  }

  if (command === 'init') {
    console.log('已废弃，请使用: codebrain setup');
    return;
  }

  // ---- 需要 storage 的命令 ----

  const storage = new StorageEngine();
  await storage.initialize();
  const index = storage.getIndex();

  try {
    switch (command) {
      case 'stats': {
        const s = await storage.stats();
        console.log(`${s.totalGroups} 组 | ${s.totalEvents} 事件`);
        break;
      }

      case 'list': {
        const tag = args.includes('--tag') ? args[args.indexOf('--tag') + 1] : undefined;
        const all = index.getAll()
          .filter((k) => (tag ? k.tags.includes(tag) : true))
          .sort((a, b) => b.occurrences - a.occurrences);

        if (all.length === 0) { console.log('知识库为空。'); break; }

        const bar = '─'.repeat(52);
        console.log(`\n${bar}`);
        console.log(` ${all.length} 组`);
        console.log(bar);

        for (const k of all.slice(0, 20)) {
          const suppressed = k.solutions.some((s) => s.suppressed);
          const icon = suppressed ? '⊘' : '●';
          const trunc = (s: string, n: number) => s.length > n ? s.slice(0, n) + '…' : s;
          console.log(` ${icon} ${k.groupId} | ${trunc(k.summary, 40)}`);
        }
        if (all.length > 20) console.log(`  ... 还有 ${all.length - 20} 条`);
        console.log(`${bar}\n`);
        break;
      }

      case 'tree': {
        const all = index.getAll().sort((a, b) => b.occurrences - a.occurrences);
        if (all.length === 0) { console.log('知识库为空。'); break; }

        // 构建层级树
        interface TreeNode {
          name: string;
          children: Map<string, TreeNode>;
          items: typeof all;
        }
        const root: TreeNode = { name: '', children: new Map(), items: [] };

        for (const k of all) {
          const path = (k.category || 'other').split('/');
          let node = root;
          for (const seg of path) {
            if (!node.children.has(seg)) {
              node.children.set(seg, { name: seg, children: new Map(), items: [] });
            }
            node = node.children.get(seg)!;
          }
          node.items.push(k);
        }

        const bar = '─'.repeat(52);
        console.log(`\n${bar}`);
        console.log(` ${all.length} 组 | ${all.reduce((s,k)=>s+k.occurrences,0)} 次`);
        console.log(bar);

        function printNode(node: TreeNode, depth: number) {
          const indent = '  '.repeat(depth);
          // 打印当前层的条目
          for (const k of node.items) {
            const suppressed = k.solutions.some((s) => s.suppressed);
            const icon = suppressed ? '⊘' : '●';
            const trunc = (s: string, n: number) => s.length > n ? s.slice(0, n) + '…' : s;
            console.log(`${indent} ${icon} ${trunc(k.summary, 40 - depth * 2)}`);
          }
          // 递归子分类
          for (const [, child] of node.children) {
            const total = countItems(child);
            console.log(`${indent} ${child.name}/ (${total})`);
            printNode(child, depth + 1);
          }
        }

        function countItems(node: TreeNode): number {
          let n = node.items.length;
          for (const [, c] of node.children) n += countItems(c);
          return n;
        }

        printNode(root, 0);
        console.log(`\n${bar}\n`);
        break;
      }

      case 'show': {
        const groupId = args[1];
        if (!groupId) { console.log('用法: codebrain show <groupId>'); break; }
        const k = index.get(groupId);
        if (!k) { console.log(`未找到: ${groupId}`); break; }

        const bar = '─'.repeat(60);
        console.log(`\n${bar}`);
        console.log(` ${k.groupId}  ${k.status === 'deprecated' ? '[已弃用]' : ''}`);
        console.log(bar);
        console.log(` 分类: ${k.category || 'other'} | 摘要: ${k.summary}`);
        console.log(` 模板: ${k.errorTemplate}`);
        console.log(` 出现: ${k.occurrences} 次 | 标签: ${k.tags.join(', ') || '-'}`);
        if (k.dependencyVersions) {
          console.log(` 版本: ${Object.entries(k.dependencyVersions).map(([n,v])=>`${n}@${v}`).join(', ')}`);
        }

        for (let i = 0; i < k.solutions.length; i++) {
          const s = k.solutions[i];
          const icon = s.suppressed ? '⊘' : '✓';
          console.log(`\n ${icon} 方案 ${i + 1}  v${s.verifiedCount}  ${s.suppressed ? '(已抑制)' : ''}`);
          console.log(`   fix:   ${s.strategy}`);
          console.log(`   root:  ${s.rootCause}`);
          console.log(`   avoid: ${s.avoidanceHint}`);
          if (s.executionTrace) {
            console.log(`   trace: ${s.executionTrace.command} (exit ${s.executionTrace.exitCode})`);
          }
        }

        if (k.abstractRule) {
          console.log(`\n 规则: ${k.abstractRule}`);
          console.log(` 预防: ${k.preventionAdvice}`);
        }
        console.log(`\n${bar}\n`);
        break;
      }

      case 'search': {
        const kw = args[1];
        if (!kw) { console.log('用法: codebrain search <keyword>'); break; }
        const matches = index.getAll().filter(
          (k) => k.summary.includes(kw) || k.errorTemplate.includes(kw) || k.tags.some((t) => t.includes(kw)),
        );
        matches.forEach((k) => console.log(`[${k.groupId}] ${k.summary} (${k.occurrences}次)`));
        break;
      }

      case 'prune': {
        const deprecated = index.getAll().filter((k) => k.status === 'deprecated');
        if (deprecated.length === 0) { console.log('无待清理条目。'); break; }
        console.log(`清理 ${deprecated.length} 条 deprecated 条目:`);
        for (const k of deprecated) {
          console.log(`  - ${k.groupId}: ${k.summary}`);
          index.remove(k.groupId);
        }
        // 更新磁盘
        const { SQLiteStore } = require('../storage/sqlite-store.js');
        const { getDefaultDbPath } = require('../storage/storage-engine.js');
        const disk = new SQLiteStore(getDefaultDbPath());
        await disk.init();
        for (const k of deprecated) disk.delete(k.groupId);
        disk.close();
        console.log('已清理。');
        break;
      }

      case 'hook': {
        const sub = args[1];
        const agent = args[2];
        if (!sub || !agent) { console.log('用法: codebrain hook <register|unregister> <agent>'); break; }
        if (agent === 'claude-code') {
          const { register, unregister } = require('../adapters/claude-code/register.js');
          sub === 'register' ? register() : unregister();
        } else {
          console.log(`Agent "${agent}" 尚未支持。`);
        }
        break;
      }

      default:
        console.log(`未知命令: ${command}`);
        console.log(`用法: codebrain <stats|list|show|search|prune|setup|daemon|hook>`);
    }
  } finally {
    storage.close();
  }
}

main().catch(console.error);
