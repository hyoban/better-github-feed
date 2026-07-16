import { createAuthClient } from 'better-auth/react'

export const authClientOptions = {
  sessionOptions: {
    // LocalFirstAccountBoundary owns focus, online, and cross-tab account verification.
    // Better Auth's default focus refetch would restart that account boot flow on every tab return.
    refetchOnWindowFocus: false,
  },
} as const

export const authClient = createAuthClient(authClientOptions)
