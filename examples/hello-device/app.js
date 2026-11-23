// A tiny ES5 device app to try teleport against: D-pad focus, console output, a network request and
// localStorage, so each DevTools panel has something to show.
(function () {
  var COLS = 4;
  var grid = document.getElementById('grid');
  var status = document.getElementById('status');
  var tiles = [];
  var focus = 0;

  function render() {
    for (var i = 0; i < tiles.length; i++) tiles[i].className = i === focus ? 'tile focused' : 'tile';
  }

  function load(items) {
    for (var i = 0; i < items.length; i++) {
      var el = document.createElement('div');
      el.textContent = items[i].title;
      grid.appendChild(el);
      tiles.push(el);
    }
    focus = Math.min(Number(localStorage.getItem('hello-device.focus')) || 0, tiles.length - 1);
    render();
    console.log('hello-device: loaded ' + items.length + ' tiles');
  }

  var xhr = new XMLHttpRequest();
  xhr.open('GET', 'items.json');
  xhr.onload = function () {
    load(JSON.parse(xhr.responseText));
  };
  xhr.send();

  document.addEventListener('keydown', function (e) {
    var key = e.keyCode;
    if (key === 37) focus = Math.max(0, focus - 1);
    else if (key === 39) focus = Math.min(tiles.length - 1, focus + 1);
    else if (key === 38) focus = Math.max(0, focus - COLS);
    else if (key === 40) focus = Math.min(tiles.length - 1, focus + COLS);
    else if (key === 13) {
      status.textContent = 'Selected ' + tiles[focus].textContent;
      console.log('hello-device: selected', { index: focus, title: tiles[focus].textContent });
      return;
    } else return;
    localStorage.setItem('hello-device.focus', String(focus));
    render();
  });
})();
