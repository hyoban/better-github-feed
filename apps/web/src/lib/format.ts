export function formatTypeLabel(type: string) {
  return type
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

// Cache formatters for better performance (Vercel React Best Practices: Locale & i18n)
const dayFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: '2-digit',
  year: 'numeric',
})

const timeFormatter = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
})

export function formatDay(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return 'Unknown date'
  }

  return dayFormatter.format(date)
}

export function formatTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return 'Unknown time'
  }

  return timeFormatter.format(date)
}

export function formatRelativeTime(date: Date | string | null) {
  if (!date) {
    return 'Never'
  }

  const dateObj = typeof date === 'string' ? new Date(date) : date
  const now = Date.now()
  const diff = now - dateObj.getTime()
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (seconds < 60) {
    return 'Just now'
  }
  if (minutes < 60) {
    return `${minutes}m ago`
  }
  if (hours < 24) {
    return `${hours}h ago`
  }
  return `${days}d ago`
}

export function convertRelativeLinksToAbsolute(html: string) {
  return html
    .replace(/(href|src)=["'](\/)([^"']*)["']/gi, '$1="https://github.com$2$3"')
    .replace(/<a(?![^>]*target=)/gi, '<a target="_blank" rel="noreferrer"')
}
