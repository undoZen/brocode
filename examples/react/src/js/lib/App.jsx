'use strict'

export default class App extends React.Component {
  constructor(props) {
    super(props)
    this.state = props.store.getState()
    const {dispatch} = props.store
    props.store.subscribe(() => this.setState(props.store.getState()))
    this.add = () => dispatch({type: 'INCREMENT'})
  }
  render () {
    return <div className="tc mv7">
      <div className="dib h4 w4 bg-black-10" onClick={this.add}>count: {this.state.count}</div>
    </div>
  }
}

