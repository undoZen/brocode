'use strict'

const rollup = require('rollup')
const json = require('rollup-plugin-json')
const _ = require('lodash')
const bluebird = require('bluebird')

module.exports = function(filePath, external, cache) {
  const opts = _.assign(
    {
      entry: filePath,
      plugins: [json()],
    },
    (external && external.length ? {external} : {}),
    (cache && typeof cache.generate === 'function' ? {cache} : {})
  )
  const bundle = rollup.rollup(opts).then((bundle) => {
    bundle.globals = _(bundle.imports)
      .map(im => [im, `EXTERNALS["${im}"]`])
      .fromPairs()
      .value()
    _.assign(bundle, bundle.generate({
      format: 'iife',
      globals: bundle.globals,
    }))
    return bundle
  })
  return bluebird.resolve(bundle)
}
