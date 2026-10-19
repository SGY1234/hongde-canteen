'use strict';
/**
 * 查本机当前的公网出口（IPv4 / IPv6），用来判断"换网络后到底变没变"
 * 用法：node scripts/show-ip.js
 */

const SOURCES = [
  { tag: 'IPv4', url: 'https://api.ipify.org?format=json', pick: (t) => { try { return JSON.parse(t).ip; } catch (e) { return t.trim(); } } },
  { tag: 'IPv4', url: 'https://ipv4.icanhazip.com', pick: (t) => t.trim() },
  { tag: 'IPv6', url: 'https://api64.ipify.org?format=json', pick: (t) => { try { return JSON.parse(t).ip; } catch (e) { return t.trim(); } } },
  { tag: 'IPv6', url: 'https://ipv6.icanhazip.com', pick: (t) => t.trim() }
];

(async () => {
  console.log('\n=== 本机公网出口 ===\n');
  for (const s of SOURCES) {
    try {
      const res = await fetch(s.url, { signal: AbortSignal.timeout(12000) });
      const ip = s.pick(await res.text());
      const kind = ip.indexOf(':') >= 0 ? 'IPv6' : 'IPv4';
      console.log('  ' + kind + '  ' + ip);
    } catch (e) {
      console.log('  ' + s.tag + '  ' + s.url + ' 取不到（' + (e.name || e.message) + '）');
    }
  }
  console.log('\n  说明：换网络后这个值会变。如果换了网络它没变，说明出口没换。\n');
})().catch((e) => { console.error('出错：' + e.message); process.exit(1); });
