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

  const handleChange = (event: React.FormEvent<HTMLInputElement>) => {
    const inputValue = event.currentTarget.value
    setValue(inputValue)
  }

  const handleSubmit = useCallback(() => {
    try {
      let parsedDate: Date | undefined
      if (isMatch(value, 'yyyy-MM-dd HH:mm:ss')) {
        parsedDate = parse(value, 'yyyy-MM-dd HH:mm:ss', new Date())
      } else if (isMatch(value, 'yyyy-MM-dd HH:mm')) {
        parsedDate = parse(value, 'yyyy-MM-dd HH:mm', new Date())
      } else if (isMatch(value, 'yyyy-MM-dd')) {
        parsedDate = parse(value, 'yyyy-MM-dd', new Date())
      }
      if (parsedDate) {
        onChange(parsedDate)
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
