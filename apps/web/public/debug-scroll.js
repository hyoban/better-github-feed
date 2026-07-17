if (new URLSearchParams(location.search).has('debug-scroll')) {
  const startedAt = performance.now()
  window.__scrollProbe = []
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
      viewportScrollbar: window.innerWidth - root.clientWidth,
      stylesheets: document.styleSheets.length,
      root: describe(root),
      body: describe(document.body),
      sidebar: describe(sidebar),
      scrollPanel: describe(scrollPanel),
    }
    const signature = JSON.stringify({ ...state, elapsed: 0 })
    if (signature !== previous) {
      window.__scrollProbe.push(state)
      previous = signature
    }
    if (performance.now() - startedAt < 15_000) requestAnimationFrame(sample)
  }

  requestAnimationFrame(sample)
}
