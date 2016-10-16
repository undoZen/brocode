'use strict';

const STEP = 1

export default function (state = {count: 0}, action) {
  if (action.type === 'INCREMENT') {
    return {
      ...state,
      count: state.count + STEP
    }
  } else {
    return state
  }
}
