import type { GardeniaApi } from './index'

declare global {
  interface Window {
    gardenia: GardeniaApi
  }
}
