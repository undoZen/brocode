'use strict';
// @flow
// import React from 'react'
// React already imported in global.js
import ReactDOM from 'react-dom'
import store from '../lib/store'

function render() {
  let App = require('../lib/App').default
  ReactDOM.render(React.createElement(App, {store}),
    document.getElementById('app-container'))
}
render()

if (process.env.NODE_ENV === 'development' && module.hot) {
  require('../lib/load-style')
  module.hot.accept('../lib/App', render)
}
