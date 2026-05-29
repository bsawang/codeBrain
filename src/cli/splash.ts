import figlet from 'figlet';

export function renderSplash(): string {
  const title = figlet.textSync('CODEBRAIN', { font: 'ANSI Shadow' });
  const bar = '─'.repeat(70);
  return `\n\n${title}\n${bar}\n  AI 编码 Agent 自进化错误记忆框架  v0.1.0\n`;
}

export function showSplash(): void {
  console.log(renderSplash());
}
