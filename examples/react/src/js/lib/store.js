'use strict';
import {createStore} from 'redux'
import reducer from './reducer'

const store = createStore(reducer)
export default store

if (process.env.NODE_ENV === 'development' && module.hot) {
  module.hot.accept('./reducer', () => store.replaceReducer(require('./reducer').default))
}
