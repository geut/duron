'use client'

import { Search, X } from 'lucide-react'
import { parseAsString, useQueryState } from 'nuqs'
import { useCallback, useEffect, useRef, useState } from 'react'

import { Input } from '@/components/ui/input'
import { useDebouncedCallback } from '@/hooks/use-debounced-callback'
import { cn } from '@/lib/utils'

interface JobSearchProps {
  className?: string
}

export function JobSearch({ className }: JobSearchProps) {
  const [search, setSearch] = useQueryState('search', parseAsString.withDefault(''))
  const [inputValue, setInputValue] = useState(search)
  const inputRef = useRef<HTMLInputElement>(null)

  // Debounce the search query update with 1000ms delay
  const debouncedSetSearch = useDebouncedCallback((value: string | null) => {
    setSearch(value)
  }, 1000)

  // Sync input value with query state when it changes externally (e.g., clear button)
  useEffect(() => {
    setInputValue(search)
  }, [search])

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value || null
      setInputValue(value || '')
      debouncedSetSearch(value)
    },
    [debouncedSetSearch],
  )

  const handleClear = useCallback(() => {
    setInputValue('')
    setSearch(null)
    inputRef.current?.focus()
  }, [setSearch])

  return (
    <div className={cn('relative flex items-center', className)}>
      <Search className="absolute left-3 h-4 w-4 text-muted-foreground pointer-events-none" />
      <Input
        ref={inputRef}
        type="text"
        placeholder="Search jobs..."
        value={inputValue}
        onChange={handleChange}
        className="pl-9 pr-9 w-full max-w-full"
      />
      {inputValue && (
        <button
          type="button"
          onClick={handleClear}
          className="absolute right-3 h-4 w-4 text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Clear search"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}
