// Which focus ring does a device draw fastest? Three ways to mark the focused tile, each pressed through
// a rail of 40 tiles with the remote. teleport profiles every run; compare `keyFrameMs`,
// `frameP95Ms` and `layoutMs` in the report.
//
//   npx tlpt q trial examples/trials/focus-ring.mjs
//
// Everything below the laptop's `export default` runs on the device, so it is ES5.
const tiles = Array.from({ length: 40 }, (_, i) => `<div class="tile">${i + 1}</div>`).join('');

export default {
  name: 'focus ring',
  runs: 5,
  keys: ['right', 'right', 'right', 'right', 'left', 'left', 'left', 'left'],
  keyGapMs: 300,
  html: `<style>#rail{display:flex;padding:40px;gap:16px;overflow:hidden}.tile{flex:0 0 200px;height:300px;background:#222;color:#fff;font:32px sans-serif;line-height:300px;text-align:center}</style><div id="rail">${tiles}</div>`,
  // The rail moves a class on keydown, as apps for these devices do, instead of DOM focus.
  setup: `var tiles=document.getElementsByClassName('tile'),at=0;tiles[0].className='tile focused';
document.addEventListener('keydown',function(e){var k=e.keyCode;if(k!==37&&k!==39)return;tiles[at].className='tile';at=Math.max(0,Math.min(tiles.length-1,at+(k===39?1:-1)));tiles[at].className='tile focused'});`,
  variants: [
    { name: 'outline', setup: 'var s=document.createElement("style");s.textContent=".focused{outline:6px solid #fff}";document.head.appendChild(s)' },
    { name: 'box-shadow', setup: 'var s=document.createElement("style");s.textContent=".focused{box-shadow:0 0 0 6px #fff,0 12px 40px rgba(0,0,0,.6)}";document.head.appendChild(s)' },
    { name: 'scale', setup: 'var s=document.createElement("style");s.textContent=".tile{transition:transform .2s}.focused{transform:scale(1.1)}";document.head.appendChild(s)' },
  ],
  checks: {
    willChange: "typeof CSS!=='undefined'&&CSS.supports?CSS.supports('will-change','transform'):null",
    transitions: "'transition' in document.documentElement.style||'webkitTransition' in document.documentElement.style",
  },
};
