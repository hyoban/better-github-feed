if (new URLSearchParams(location.search).has('debug-scroll')) {
  const startedAt = performance.now()
  const samples = []
  const output = document.createElement('script')
  output.id = 'debug-scroll-probe-data'
  output.type = 'application/json'
  output.hidden = true
  document.body.append(output)
  let previous = ''

  const describe = element =>
    element
      ? {
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          overflowY: getComputedStyle(element).overflowY,
        }
      : null

  const sample = () => {
    const root = document.documentElement
    const sidebar = document.querySelector('aside')
    const scrollPanel = document.querySelector('.scroll-panel')
    const state = {
      elapsed: Math.round(performance.now() - startedAt),
      visibility: document.visibilityState,
      viewportScrollbar: window.innerWidth - root.clientWidth,
      stylesheets: document.styleSheets.length,
      root: describe(root),
      body: describe(document.body),
      sidebar: describe(sidebar),
      panelContent: describe(sidebar?.parentElement),
      scrollPanel: describe(scrollPanel),
    }
    const signature = JSON.stringify({ ...state, elapsed: 0 })
    if (signature !== previous) {
      samples.push(state)
      output.textContent = JSON.stringify(samples)
      previous = signature
    }
  }

  sample()
  const timer = setInterval(sample, 25)
  setTimeout(() => clearInterval(timer), 60_000)
}
