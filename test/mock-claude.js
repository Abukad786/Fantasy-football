// Stand-in for the Claude Messages API (streaming) to test the coach locally.
// Run: node test/mock-claude.js, then start the server with ANTHROPIC_BASE_URL=http://localhost:4200 ANTHROPIC_API_KEY=test
import http from 'node:http';
import fs from 'node:fs';
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    fs.writeFileSync(process.env.MOCK_LOG || '/dev/null', body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
    ev('content_block_start', { index: 0, content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} } });
    ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"FPL team news"}' } });
    ev('content_block_stop', { index: 0 });
    ev('content_block_start', { index: 1, content_block: { type: 'text', text: '' } });
    const text = '**Captain Haaland.** He has the best fixture.\n\n- Option 2: *Salah*\n- Avoid a hit this week\n\nSee [FPL](https://fantasy.premierleague.com).';
    let i = 0;
    const t = setInterval(() => {
      if (i < text.length) { ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: text.slice(i, i + 12) } }); i += 12; return; }
      clearInterval(t);
      ev('content_block_stop', { index: 1 });
      ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 40 } });
      ev('message_stop', {});
      res.end();
    }, 30);
  });
}).listen(4200, () => console.log('mock claude on 4200'));
