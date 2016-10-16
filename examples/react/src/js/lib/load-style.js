'use strict'

var linkEl
function removeEl(el) {
  el && el.parentNode && el.parentNode.removeChild(el)
}
function getCssEl(p) {
  return document.querySelector(`link[href^="${p}"]`)
}

function appendCssEl(p) {
  var elem = document.createElement('link');
  elem.setAttribute('rel', 'stylesheet');
  elem.setAttribute('type', 'text/css');
  elem.setAttribute('href', p + `?_=${Math.random()}`);
  var head = document.getElementsByTagName('head')[0];
  head.appendChild(elem);
  return elem;
}

require('../../css/style.css') // for triggering hot reload
linkEl = getCssEl('/css/style.css')
if(module.hot) {
  module.hot.accept('../../css/style.css', function() {
    removeEl(linkEl)
    linkEl = appendCssEl('/css/style.css')
  })
}
