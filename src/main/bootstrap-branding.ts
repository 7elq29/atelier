import { app } from 'electron'
import { APP_DISPLAY_NAME } from '../shared/app-brand'

if (!app.isReady()) {
  app.setName(APP_DISPLAY_NAME)
}
process.title = APP_DISPLAY_NAME
