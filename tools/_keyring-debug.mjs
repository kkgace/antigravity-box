
const { WindowsCredentialAdapter } = await import('../dist/windows/keyring.js');
const a = new WindowsCredentialAdapter();
const p = await a.readPassword('gemini', 'antigravity');
const j = JSON.parse(p);
const walk = (obj, path, depth) => {
  if (depth > 3 || !obj || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    const t = typeof v;
    console.log('KEY:', path + k, '=', t === 'string' ? (k.includes('token') && k !== 'token' ? '<redacted len ' + v.length + '>' : (v.length > 60 ? '<string len ' + v.length + '>' : v)) : t === 'number' ? v : t === 'object' ? '{...}' : v);
    if (t === 'object' && k !== 'token') walk(v, path + k + '.', depth + 1);
    if (k === 'token' && t === 'object') {
      for (const [tk, tv] of Object.entries(v)) {
        console.log('  token.' + tk, '=', typeof tv === 'string' && (tk.includes('token') || tk === 'id_token') ? '<len ' + tv.length + '>' : tv);
      }
    }
  }
};
walk(j, '', 0);
