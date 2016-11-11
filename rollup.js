'use strict'

var rollup = require( 'rollup' )
var json = require( 'rollup-plugin-json' )
var _ = require('lodash')
var Promise = require('bluebird')

module.exports = function(filePath, external, cache) {
  const opts = _.assign(
    {
      entry: filePath,
      plugins: [json()],
    },
    (external && external.length ? {external} : {}),
    (cache && typeof cache.generate === 'function' ? {cache} : {})
  )
  return Promise.resolve(rollup.rollup(opts).then((bundle) => {
    bundle.globals = _(bundle.imports)
      .map(im => [im, `EXTERNALS["${im}"]`])
      .fromPairs()
      .value()
    _.assign(bundle, bundle.generate({
      format: 'iife',
      globals: bundle.globals,
    }))
    return bundle
  }))
}
