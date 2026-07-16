import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

type NavigatorWithStandalone = Navigator & { readonly standalone?: boolean }

function isStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as NavigatorWithStandalone).standalone === true
  )
}

function subscribeToStandalone(change: () => void) {
  const displayMode = window.matchMedia('(display-mode: standalone)')
  displayMode.addEventListener('change', change)
  window.addEventListener('appinstalled', change)
  return () => {
    displayMode.removeEventListener('change', change)
    window.removeEventListener('appinstalled', change)
  }
}

export function usePwaInstall() {
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [installedThisSession, setInstalledThisSession] = useState(false)
  const [canExplainManualInstall, setCanExplainManualInstall] = useState(false)
  const standalone = useSyncExternalStore(subscribeToStandalone, isStandalone, () => false)

  useEffect(() => {
    const capturePrompt = (event: Event) => {
      event.preventDefault()
      setInstallPrompt(event as BeforeInstallPromptEvent)
    }
    const markInstalled = () => {
      setInstallPrompt(null)
      setInstalledThisSession(true)
    }

    setCanExplainManualInstall(
      'share' in navigator && window.matchMedia('(pointer: coarse)').matches,
    )
    window.addEventListener('beforeinstallprompt', capturePrompt)
    window.addEventListener('appinstalled', markInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', capturePrompt)
      window.removeEventListener('appinstalled', markInstalled)
    }
  }, [])

  const install = useCallback(async () => {
    if (!installPrompt) return false
    await installPrompt.prompt()
    const choice = await installPrompt.userChoice
    setInstallPrompt(null)
    return choice.outcome === 'accepted'
  }, [installPrompt])

  return {
    standalone,
    canInstall: !standalone && !installedThisSession && installPrompt !== null,
    canExplainManualInstall:
      !standalone && !installedThisSession && !installPrompt && canExplainManualInstall,
    install,
  }
}
