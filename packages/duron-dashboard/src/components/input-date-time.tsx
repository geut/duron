'use client'

import { maskitoDateTimeOptionsGenerator } from '@maskito/kit'
import { useMaskito } from '@maskito/react'
import { format, isMatch, parse } from 'date-fns'
import { useCallback, useEffect, useId, useState } from 'react'

import { Input } from '@/components/ui/input'

interface InputDateTimeProps {
  date?: Date
  onChange: (date: Date) => void
}

const dateOptions = maskitoDateTimeOptionsGenerator({
  dateSeparator: '-',
  dateTimeSeparator: ' ',
  dateMode: 'yyyy/mm/dd',
  timeMode: 'HH:MM:SS',
})

const InputDateTime = ({ date, onChange }: InputDateTimeProps) => {
  const id = useId()
  const [value, setValue] = useState<string>('')

  useEffect(() => {
    if (date) {
      setValue(format(date, 'yyyy-MM-dd HH:mm:ss'))
    }
  }, [date])

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value
    setValue(value)
  }

  const handleSubmit = useCallback(() => {
    try {
      let date: Date | undefined
      if (isMatch(value, 'yyyy-MM-dd HH:mm:ss')) {
        date = parse(value, 'yyyy-MM-dd HH:mm:ss', new Date())
      } else if (isMatch(value, 'yyyy-MM-dd HH:mm')) {
        date = parse(value, 'yyyy-MM-dd HH:mm', new Date())
      } else if (isMatch(value, 'yyyy-MM-dd')) {
        date = parse(value, 'yyyy-MM-dd', new Date())
      }
      if (date) {
        onChange(date)
      }
    } catch {
      // do nothing
    }
  }, [value, onChange])

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      handleSubmit()
    }
  }

  const handleBlur = () => {
    handleSubmit()
  }

  return (
    <Input
      id={id}
      type="text"
      placeholder="yyyy-mm-dd HH:MM:SS"
      ref={useMaskito({
        options: dateOptions,
      })}
      onInput={handleChange}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      value={value}
    />
  )
}

export default InputDateTime
