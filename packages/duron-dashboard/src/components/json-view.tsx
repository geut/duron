import ReactJsonView from '@uiw/react-json-view'
import { githubDarkTheme as darkTheme } from '@uiw/react-json-view/githubDark'
import { githubLightTheme as lightTheme } from '@uiw/react-json-view/githubLight'

import { useTheme } from '@/contexts/theme-context'

export function JsonView({ value }: { value: any }) {
  const { theme } = useTheme()
  const themeStyle = theme === 'dark' ? darkTheme : lightTheme

  return (
    <ReactJsonView
      value={value}
      style={{
        ...themeStyle,
        backgroundColor: 'transparent',
      }}
      highlightUpdates={false}
      shortenTextAfterLength={100}
      objectSortKeys={true}
      displayDataTypes={false}
      collapsed={1}
    />
  )
}
