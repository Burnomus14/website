# The Collection

An AMOLED black/white catalog site for your shoe and clothes collection, with a password-protected admin panel to add items, edit captions, and mark pieces as **In stock** or **Sold**.

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
   - Admin panel: http://localhost:3000/admin.html

The local `.env` file contains the server port and seller WhatsApp number. It is ignored by Git and should never be committed.

## How it works

- **Data** lives in `data/items.json` — a plain JSON file, human-readable if you want to peek or hand-edit it.
- **Images** you upload through the admin panel are saved into `public/uploads/`.
- **Admin sessions** are simple in-memory tokens — signing in gives your browser a token stored in `localStorage`; restarting the server signs everyone out.
- The public gallery (`/`) only ever reads data — nothing there can add, edit, or delete anything.

## Adding items

Go to the admin panel, sign in, and use the "Add a new item" form. Each item has:
- **Name** and **category** (shoes / clothes) — required
- **Price** and **caption** — optional
- **Status** — In stock, In the archive, or Sold (you can also change this later with a single dropdown per row, without re-editing the whole item)
- **Image** — optional, shown as a placeholder card if left off

## Deploying it live

This is a small Node app, so it deploys easily to something like Render, Railway, or a VPS — anywhere that can run `npm install && npm start` and keep a persistent disk for `data/` and `public/uploads/`. (Free static hosts like Netlify/Vercel won't work as-is since this needs a running Node server, not just static files.)

### Render

1. Push this project to a GitHub repository.
2. In Render, choose **New > Blueprint**, connect the repository, and select `render.yaml`.
3. Set the secret environment variables when Render prompts you:
   - `SELLER_PHONE_NUMBER` = `254728074301`
   - `ADMIN_PASSWORD` = your private admin password
   - `API_SECRET_KEY` = a private random value
   - `DATABASE_URL` = your database connection string, if used
4. Deploy the web service. Render provides the public URL after the build finishes.

The included `render.yaml` configures `npm install` and `npm start`. Render web services have an ephemeral filesystem by default, so configure persistent storage or external storage before relying on uploaded images and catalog data in production.

## Customizing the look

All colors, type, and spacing live in `public/css/style.css` under the `:root` block at the top — change the hex values there to retheme the whole site at once.
