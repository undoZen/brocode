'use strict'
var fs = require('fs')
var path = require('path')
var cpr = require('cpr')
exports.cpr = function(demo) {
  if (demo !== 'react' && demo !== 'vue') {
    console.log(`
  brocode init [vue | react]

    currently brocode only support init vue or react project
    try again with command:

      brocode init vue
      brocode init react
`)
    return
  }
  if (fs.readdirSync(process.cwd()).length) {
    console.log('please run `brocode init [vue|react]` in an empty directory')
    return
  }
  cpr(path.join(__dirname, 'examples', demo), process.cwd(), {
    overwrite: true
  }, function(err, file) {
    if (err) {
      console.error('something wrong:', err);
    }
    console.log('done, now run `npm i` and `brocode server` to start');
  })
}
