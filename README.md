# The Collection

An AMOLED black/white catalog and marketplace for your shoe and clothes collection, with customer accounts, a saved basket and wishlist, delivery addresses, order tracking, seller tools, shipper fulfillment, and a password-protected admin panel.

## Setup (in VS Code)

1. Open this folder in VS Code.
2. Open a terminal (``Ctrl+` `` / ``Cmd+` ``) and install dependencies:
   ```
   npm install
   ```
3. **Set your admin password.** Open `server.js` and change this line near the top:
   ```js
   const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme123';
   ```
   Replace `'changeme123'` with your own password. (Or, instead of editing the file, run the server with `ADMIN_PASSWORD=yourpassword npm start`.)
4. Start the server:
   ```
   npm start
   ```
5. Open the site:
   - Gallery: http://localhost:3000
   - Customer and marketplace accounts: http://localhost:3000/account.html
   - Admin panel: http://localhost:3000/admin.html

The local `.env` file contains the server port and seller WhatsApp number. It is ignored by Git and should never be committed.

Admin password reset email uses Resend. Configure `RESEND_API_KEY`, `RESEND_FROM_EMAIL` (a verified sender), and `PUBLIC_BASE_URL` (the site's public HTTPS origin) in `.env` or your hosting provider. Reset links expire after 30 minutes and can only be used once. Requests return a generic response to avoid confirming whether an email belongs to an admin.

## M-Pesa Daraja checkout

The storefront uses Daraja STK Push. Add these values to `.env` for local testing or configure them as secrets in your hosting provider:

```env
MPESA_ENVIRONMENT=sandbox
MPESA_CONSUMER_KEY=your_daraja_consumer_key
MPESA_CONSUMER_SECRET=your_daraja_consumer_secret
MPESA_PASSKEY=your_stk_push_passkey
MPESA_SHORTCODE=174379
MPESA_TRANSACTION_TYPE=CustomerPayBillOnline
MPESA_CALLBACK_URL=https://your-public-domain.example/api/mpesa/callback
```

Create an app in the Safaricom Daraja portal to obtain the consumer key and secret. Use the matching sandbox or production shortcode and passkey. The callback URL must be publicly reachable over HTTPS; local `localhost` URLs cannot receive Daraja callbacks. Set `MPESA_ENVIRONMENT=production` only after the production app and shortcode are approved.

## Marketplace accounts and roles

Customers can create an account at `/account.html` to keep a basket and wishlist, manage delivery addresses, and track paid M-Pesa orders. Customers can apply to become sellers; an admin approves seller, shipper, and additional admin roles from **Marketplace** in the admin panel or account page. Sellers manage their own products and shipping queue, while shippers only receive orders assigned to their configured delivery area.

Marketplace data uses Firestore when Firebase credentials are configured. It is stored in the `marketplace_users`, `marketplace_carts`, `marketplace_wishlists`, `marketplace_addresses`, `marketplace_orders`, `marketplace_shippers`, and `marketplace_categories` collections; marketplace passwords are stored as scrypt hashes. Without Firestore credentials, the app uses `data/marketplace.json` for local development, and that file is ignored by Git because it contains personal account and delivery information.

Marketplace sign-in tokens are held in server memory and browser local storage; restarting the server invalidates active sessions. Paid M-Pesa checkouts create order records for signed-in customers and guest purchases alike, but only signed-in customers can view their order history.

## How it works

- **Catalog data** lives in Firestore's `products` collection when Firebase is configured, or `data/items.json` in local fallback mode.
- **Marketplace accounts and order data** use the Firestore collections documented above, or the ignored `data/marketplace.json` local fallback.
- **Images** you upload through the admin panel are saved into `public/uploads/`.
- **Admin sessions** are simple in-memory tokens — signing in gives your browser a token stored in `localStorage`; restarting the server signs everyone out.
- The public gallery (`/`) only ever reads data — nothing there can add, edit, or delete anything.

## Adding items

Go to the admin panel, sign in, and use the "Add a new item" form. Each item has:
- **Name** and **category** (shoes / clothes) — required
- **Quantity in stock** — a non-negative whole number; positive quantities are in stock and zero is sold
- **Status** — In the archive is a manual override available from the item form or table
- **Price** and **caption** — optional
- **Image** — optional, shown as a placeholder card if left off

## Deploying it live
Only in-stock items can be added to the basket or checked out with M-Pesa. Sold and archived items remain available for WhatsApp inquiries. Basket quantities cannot exceed available stock, and successful M-Pesa payments reduce the stored quantity.


This is a small Node app, so it deploys easily to something like Render, Railway, or a VPS — anywhere that can run `npm install && npm start` and keep a persistent disk for `data/` and `public/uploads/`. (Free static hosts like Netlify/Vercel won't work as-is since this needs a running Node server, not just static files.)

### Render

1. Push this project to a GitHub repository.
2. In Render, choose **New > Blueprint**, connect the repository, and select `render.yaml`.
3. Set the secret environment variables when Render prompts you:
   - `SELLER_PHONE_NUMBER` = `254728074301`
   - `ADMIN_PASSWORD` = your private admin password
   - `API_SECRET_KEY` = a private random value
   - `CLOUDINARY_CLOUD_NAME` = your Cloudinary cloud name
   - `CLOUDINARY_API_KEY` = your Cloudinary API key
   - `CLOUDINARY_API_SECRET` = your Cloudinary API secret
   - `FIREBASE_SERVICE_ACCOUNT` = the Firebase service-account JSON as a single-line value
   - `RESEND_API_KEY` = a Resend API key
   - `RESEND_FROM_EMAIL` = a verified sender address, for example `The Collection <admin@example.com>`
   - `PUBLIC_BASE_URL` = the public site origin, for example `https://your-site.onrender.com`
4. Deploy the web service. Render provides the public URL after the build finishes.

The included `render.yaml` configures `npm install`, `npm start`, and a 1 GB Persistent Disk mounted at `/opt/render/project/src/storage`. When the three Cloudinary variables are set, new admin uploads are stored in the `shoe_collection` Cloudinary folder and use permanent Cloudinary URLs. Without them, the app falls back to the persistent disk and `/uploads/<filename>` URLs. Existing local images must be uploaded again through the admin panel after the first deployment. Persistent disks are tied to one service instance; Cloudinary is preferred for multi-instance deployments.

When `FIREBASE_SERVICE_ACCOUNT` is configured, catalog records are stored in the Firestore `products` collection and M-Pesa transaction status is stored in `mpesa_transactions`. For local development, you can instead place the downloaded service-account file at `firebase-key.json`; it is ignored by Git. The Firebase browser configuration is not needed because the app accesses Firestore only from the server.

Signed-in admins can open **Transactions** from the admin navigation to view completed M-Pesa payments, including buyer details and item quantities. This history requires working Firestore credentials; pending and failed payments are not listed.

## Customizing the look

All colors, type, and spacing live in `public/css/style.css` under the `:root` block at the top — change the hex values there to retheme the whole site at once.
