// `tlpt shim`: a way past the first error an old engine throws on a modern app. While it is on, every
// page tlpt serves loads this script right after the agent and ahead of the app's own, and it fills in
// the built-ins most often missing on old Chromium, each only where the engine lacks it. What it filled
// is kept in window.__teleportShimmed, which `tlpt shim` reads back. It is hand-written ES5 and never
// throws: a fill that fails is skipped. It is a way to see past one error to the next, not a fix: the
// fix is a build target and polyfills of the app's own, and `tlpt probe features` says what is missing.

/** The path the page loads it from; tlpt serves it. */
export const SHIM_PATH = '/teleport-shim.js';
export const SHIM_TAG = `<script src="${SHIM_PATH}"></script>`;

/** The names it fills, in the order it tries them: what `tlpt shim` lists as possible. */
export const SHIM_NAMES = [
  'Object.assign',
  'Object.entries',
  'Object.values',
  'Object.fromEntries',
  'Array.from',
  'Array.of',
  'Array.prototype.find',
  'Array.prototype.findIndex',
  'Array.prototype.includes',
  'Array.prototype.fill',
  'Array.prototype.flat',
  'Array.prototype.flatMap',
  'String.prototype.includes',
  'String.prototype.startsWith',
  'String.prototype.endsWith',
  'String.prototype.repeat',
  'String.prototype.padStart',
  'String.prototype.padEnd',
  'String.prototype.trimStart',
  'String.prototype.trimEnd',
  'Number.isNaN',
  'Number.isFinite',
  'Number.isInteger',
  'Number.EPSILON',
  'Math.trunc',
  'Math.sign',
  'NodeList.prototype.forEach',
  'Element.prototype.matches',
  'Element.prototype.closest',
  'Element.prototype.remove',
  'Promise.prototype.finally',
  'requestIdleCallback',
  'CustomEvent',
] as const;

// ES5 only: no arrow functions, let, const, template strings or spread. `f(name, has, fill)` defines a
// fill where `has` is false and records the name; anything that throws is skipped.
export const SHIM_SCRIPT = `(function(){
var done=window.__teleportShimmed=window.__teleportShimmed||[];
function f(name,has,fill){try{if(has())return;fill();done.push(name);}catch(e){}}
function def(o,k,v){Object.defineProperty(o,k,{value:v,configurable:true,writable:true,enumerable:false});}
var OP=Object.prototype.hasOwnProperty,AP=Array.prototype,SP=String.prototype;
function len(o){var n=Number(o.length);return n>0?Math.min(Math.floor(n),9007199254740991):0;}
function same(a,b){return a===b?(a!==0||1/a===1/b):(a!==a&&b!==b);}
f('Object.assign',function(){return typeof Object.assign==='function';},function(){def(Object,'assign',function(t){if(t==null)throw new TypeError('Cannot convert undefined or null to object');var to=Object(t);for(var i=1;i<arguments.length;i++){var s=arguments[i];if(s!=null){for(var k in s){if(OP.call(s,k))to[k]=s[k];}}}return to;});});
f('Object.entries',function(){return typeof Object.entries==='function';},function(){def(Object,'entries',function(o){var out=[];for(var k in o){if(OP.call(o,k))out.push([k,o[k]]);}return out;});});
f('Object.values',function(){return typeof Object.values==='function';},function(){def(Object,'values',function(o){var out=[];for(var k in o){if(OP.call(o,k))out.push(o[k]);}return out;});});
f('Object.fromEntries',function(){return typeof Object.fromEntries==='function';},function(){def(Object,'fromEntries',function(it){var o={};var a=Array.from(it);for(var i=0;i<a.length;i++)o[a[i][0]]=a[i][1];return o;});});
f('Array.from',function(){return typeof Array.from==='function';},function(){def(Array,'from',function(src,map,self){var out=[],i;if(src==null)throw new TypeError('Array.from needs something to copy');var it=typeof Symbol==='function'&&Symbol.iterator&&src[Symbol.iterator];if(typeof src==='string'){for(i=0;i<src.length;i++){var c=src.charCodeAt(i);if(c>=0xd800&&c<=0xdbff&&i+1<src.length){out.push(src.charAt(i)+src.charAt(i+1));i++;}else out.push(src.charAt(i));}}else if(it){var g=it.call(src),s;while(!(s=g.next()).done)out.push(s.value);}else{for(i=0;i<len(src);i++)out.push(src[i]);}if(map){for(i=0;i<out.length;i++)out[i]=map.call(self,out[i],i);}return out;});});
f('Array.of',function(){return typeof Array.of==='function';},function(){def(Array,'of',function(){return AP.slice.call(arguments);});});
f('Array.prototype.find',function(){return !!AP.find;},function(){def(AP,'find',function(fn,self){for(var i=0,n=len(this);i<n;i++){if(fn.call(self,this[i],i,this))return this[i];}return undefined;});});
f('Array.prototype.findIndex',function(){return !!AP.findIndex;},function(){def(AP,'findIndex',function(fn,self){for(var i=0,n=len(this);i<n;i++){if(fn.call(self,this[i],i,this))return i;}return -1;});});
f('Array.prototype.includes',function(){return !!AP.includes;},function(){def(AP,'includes',function(x,from){var n=len(this),i=Math.max(from|0,0)||0;if(from<0)i=Math.max(n+(from|0),0);for(;i<n;i++){if(same(this[i],x))return true;}return false;});});
f('Array.prototype.fill',function(){return !!AP.fill;},function(){def(AP,'fill',function(v,a,b){var n=len(this),i=a==null?0:(a<0?Math.max(n+a,0):Math.min(a,n)),e=b==null?n:(b<0?Math.max(n+b,0):Math.min(b,n));for(;i<e;i++)this[i]=v;return this;});});
f('Array.prototype.flat',function(){return !!AP.flat;},function(){def(AP,'flat',function(d){d=d===undefined?1:Math.floor(d);var out=[];(function go(a,k){for(var i=0;i<a.length;i++){if(i in a){if(k>0&&Array.isArray(a[i]))go(a[i],k-1);else out.push(a[i]);}}})(this,d);return out;});});
f('Array.prototype.flatMap',function(){return !!AP.flatMap;},function(){def(AP,'flatMap',function(fn,self){return AP.map.call(this,fn,self).flat(1);});});
f('String.prototype.includes',function(){return !!SP.includes;},function(){def(SP,'includes',function(s,i){return String(this).indexOf(s,i||0)!==-1;});});
f('String.prototype.startsWith',function(){return !!SP.startsWith;},function(){def(SP,'startsWith',function(s,i){i=i>0?i|0:0;return String(this).substr(i,String(s).length)===String(s);});});
f('String.prototype.endsWith',function(){return !!SP.endsWith;},function(){def(SP,'endsWith',function(s,e){var t=String(this);e=e===undefined||e>t.length?t.length:e|0;s=String(s);return t.slice(e-s.length,e)===s;});});
f('String.prototype.repeat',function(){return !!SP.repeat;},function(){def(SP,'repeat',function(n){n=n|0;if(n<0)throw new RangeError('Invalid count value');var s=String(this),out='';while(n>0){if(n&1)out+=s;n>>=1;s+=s;}return out;});});
function pad(start){return function(n,fill){var s=String(this);n=n|0;fill=fill===undefined?' ':String(fill);if(n<=s.length||!fill)return s;var need=n-s.length,p='';while(p.length<need)p+=fill;p=p.slice(0,need);return start?p+s:s+p;};}
f('String.prototype.padStart',function(){return !!SP.padStart;},function(){def(SP,'padStart',pad(true));});
f('String.prototype.padEnd',function(){return !!SP.padEnd;},function(){def(SP,'padEnd',pad(false));});
f('String.prototype.trimStart',function(){return !!SP.trimStart;},function(){def(SP,'trimStart',SP.trimLeft||function(){return String(this).replace(/^\\s+/,'');});});
f('String.prototype.trimEnd',function(){return !!SP.trimEnd;},function(){def(SP,'trimEnd',SP.trimRight||function(){return String(this).replace(/\\s+$/,'');});});
f('Number.isNaN',function(){return typeof Number.isNaN==='function';},function(){def(Number,'isNaN',function(x){return typeof x==='number'&&x!==x;});});
f('Number.isFinite',function(){return typeof Number.isFinite==='function';},function(){def(Number,'isFinite',function(x){return typeof x==='number'&&isFinite(x);});});
f('Number.isInteger',function(){return typeof Number.isInteger==='function';},function(){def(Number,'isInteger',function(x){return typeof x==='number'&&isFinite(x)&&Math.floor(x)===x;});});
f('Number.EPSILON',function(){return Number.EPSILON!==undefined;},function(){def(Number,'EPSILON',Math.pow(2,-52));});
f('Math.trunc',function(){return typeof Math.trunc==='function';},function(){def(Math,'trunc',function(x){x=+x;return x<0?Math.ceil(x):Math.floor(x);});});
f('Math.sign',function(){return typeof Math.sign==='function';},function(){def(Math,'sign',function(x){x=+x;return x>0?1:x<0?-1:x;});});
f('NodeList.prototype.forEach',function(){return typeof NodeList==='undefined'||!!NodeList.prototype.forEach;},function(){def(NodeList.prototype,'forEach',AP.forEach);});
var EP=typeof Element!=='undefined'?Element.prototype:null;
f('Element.prototype.matches',function(){return !EP||!!EP.matches;},function(){def(EP,'matches',EP.webkitMatchesSelector||EP.msMatchesSelector||function(s){var all=(this.ownerDocument||document).querySelectorAll(s);for(var i=0;i<all.length;i++){if(all[i]===this)return true;}return false;});});
f('Element.prototype.closest',function(){return !EP||!!EP.closest;},function(){def(EP,'closest',function(s){var el=this;while(el&&el.nodeType===1){if(el.matches(s))return el;el=el.parentNode;}return null;});});
f('Element.prototype.remove',function(){return !EP||!!EP.remove;},function(){def(EP,'remove',function(){if(this.parentNode)this.parentNode.removeChild(this);});});
f('Promise.prototype.finally',function(){return typeof Promise==='undefined'||!!Promise.prototype['finally'];},function(){def(Promise.prototype,'finally',function(fn){var C=this.constructor||Promise;return this.then(function(v){return C.resolve(fn()).then(function(){return v;});},function(e){return C.resolve(fn()).then(function(){throw e;});});});});
f('requestIdleCallback',function(){return typeof window.requestIdleCallback==='function';},function(){window.requestIdleCallback=function(fn){var t0=Date.now();return setTimeout(function(){fn({didTimeout:false,timeRemaining:function(){return Math.max(0,50-(Date.now()-t0));}});},1);};window.cancelIdleCallback=function(id){clearTimeout(id);};});
f('CustomEvent',function(){try{new CustomEvent('x');return true;}catch(e){return false;}},function(){var CE=function(type,o){o=o||{};var e=document.createEvent('CustomEvent');e.initCustomEvent(type,!!o.bubbles,!!o.cancelable,o.detail===undefined?null:o.detail);return e;};CE.prototype=window.Event.prototype;window.CustomEvent=CE;});
})();`;

/** The script a page can be asked, through the agent, for what was filled. */
export const SHIMMED_SCRIPT = 'JSON.stringify(window.__teleportShimmed||null)';
