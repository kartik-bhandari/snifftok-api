/**
 * src/tests/fixtures/customer.js
 * A signed-in storefront customer — checkout needs an account.
 */

import { User } from '../../models/User.js'
import { signToken } from '../../lib/jwt.js'
import { config } from '../../config/index.js'

/** Creates the customer and returns their session cookie header value */
export async function customerCookie(email = 'riya@test.com') {
  const user = await User.create({ email, name: 'Riya', role: 'customer', sessionVersion: 1, isActive: true })
  return `${config.cookieName}=${signToken({ sub: user._id.toString(), role: 'customer', v: 1 })}`
}
