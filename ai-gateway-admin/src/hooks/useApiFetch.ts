import { useState, useEffect, useCallback } from 'react'
import { message } from 'antd'

export function useApiFetch<T>(fetcher: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const fetch = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await fetcher()
      setData(result)
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      setError(e)
      message.error(e.message)
    } finally {
      setLoading(false)
    }
  }, [fetcher])

  useEffect(() => {
    fetch()
  }, deps)

  return { data, loading, error, refetch: fetch }
}
