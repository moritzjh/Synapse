import app from './app'
import database from './database'
import editor from './editor'
import views from './views'

export const EN: Record<string, string> = { ...app, ...views, ...editor, ...database }
