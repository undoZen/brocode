var path = require('path');
var rollup = require('./rollup')
rollup(path.join(__dirname, 'test', 'src', 'js', 'main.js'))
.then((bundle) => {
  console.log(bundle)
  console.log(bundle.code)
})
