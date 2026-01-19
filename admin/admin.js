// admin/admin.js
import AdminJS from 'adminjs'
import { Resource, Database } from '@adminjs/mongoose'
import AdminJSExpress from '@adminjs/express'
import Menu from '../../../models/menu/menu.js'

AdminJS.registerAdapter({ Resource, Database })

export const adminJs = new AdminJS({
  resources: [{ resource: Menu }],
  rootPath: '/admin',
})

export const router = AdminJSExpress.buildRouter(adminJs)