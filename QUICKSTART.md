# Quick Start Guide

Get the Allo Inventory System running in under 10 minutes.

## Prerequisites

- Node.js 18+ installed
- Git installed
- Accounts created (free):
  - [Supabase](https://supabase.com) (PostgreSQL database)
  - [Upstash](https://upstash.com) (Redis)
  - [Vercel](https://vercel.com) (Deployment - optional for local dev)

## Step-by-Step Setup

### 1. Clone Repository

```bash
git clone <repository-url>
cd allo-inventory-system
npm install
```

### 2. Set Up Database (Supabase)

1. Go to https://supabase.com/dashboard
2. Click "New Project"
3. Fill in details:
   - Name: `allo-inventory`
   - Database Password: (generate strong password)
   - Region: (closest to you)
4. Wait for project to be ready (~2 minutes)
5. Go to **Settings → Database → Connection String**
6. Copy the **URI** (Session mode, not Transaction)
7. Replace `[YOUR-PASSWORD]` with your database password

### 3. Set Up Redis (Upstash)

1. Go to https://console.upstash.com/redis
2. Click "Create Database"
3. Configure:
   - Name: `allo-inventory`
   - Type: Regional
   - Region: (same as or close to your location)
4. Click "Create"
5. Go to **REST API** tab
6. Copy both:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

### 4. Configure Environment Variables

Create `.env` file in project root:

```env
# Database (from Supabase)
DATABASE_URL="postgresql://postgres.xxx:password@aws-xxx.pooler.supabase.com:5432/postgres"

# Redis (from Upstash)
UPSTASH_REDIS_REST_URL="https://xxx.upstash.io"
UPSTASH_REDIS_REST_TOKEN="AXXXxxx..."

# App Configuration
NEXT_PUBLIC_RESERVATION_TIMEOUT_MINUTES=10
VERCEL_CRON_SECRET="my-secret-key-123"
```

**Generate a secret for `VERCEL_CRON_SECRET`:**
```bash
# On Linux/Mac
openssl rand -base64 32

# On Windows (PowerShell)
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Minimum 0 -Maximum 256 }))
```

### 5. Initialize Database

```bash
# Push Prisma schema to database (creates tables)
npx prisma db push

# Seed database with sample data (6 products × 3 warehouses)
npm run db:seed
```

**Expected output:**
```
✅ Seeded 3 warehouses
✅ Seeded 6 products
✅ Seeded 18 stock entries
🎉 Database seeded successfully!
```

### 6. Run Development Server

```bash
npm run dev
```

Open **http://localhost:3000**

You should see:
- **Header**: "Allo Inventory System"
- **6 products** with warehouse availability
- **"Reserve" buttons** for each warehouse

### 7. Test the System

#### Test 1: Create a Reservation ✅

1. Click "Reserve" on any product with available stock
2. You'll be redirected to `/reservation/{id}`
3. See:
   - ✅ Live countdown timer (10:00 → 9:59 → ...)
   - ✅ Product details with price
   - ✅ "Confirm Purchase" and "Cancel" buttons
   - ✅ Status badge showing "PENDING"

#### Test 2: Confirm Purchase ✅

1. On the reservation page, click **"Confirm Purchase"**
2. Status changes to **"CONFIRMED"**
3. Navigate back to products page
4. **Stock count decreased** (permanent sale)

#### Test 3: Cancel Reservation ✅

1. Create a new reservation
2. Click **"Cancel"** button
3. Status changes to **"RELEASED"**
4. Navigate back to products page
5. **Stock returned** to available

#### Test 4: Race Condition (Critical Test!) 🔥

1. Find a product with **2 units available**
2. Open **two browser tabs** side-by-side
3. Click **"Reserve" simultaneously** in both tabs
4. **Expected result**:
   - ✅ One tab: **Success** (201 Created, reservation created)
   - ✅ Other tab: **"Insufficient stock available"** error (409 Conflict)
   - ✅ **NO OVERSELLING** - distributed lock worked!

#### Test 5: Reservation Expiry ⏰

1. Create a reservation
2. Wait for countdown to reach **0:00**
3. **Expected**: "Reservation Expired" message appears
4. Try to click "Confirm Purchase"
5. **Expected**: **410 Gone** error

After the **cron job runs** (every 5 minutes in production, manually trigger in local):
```bash
curl http://localhost:3000/api/cron/expire-reservations
```
Check products page → **stock returned** to available

#### Test 6: Idempotency (Bonus!) 🎯

```bash
# Create reservation with idempotency key
curl -X POST http://localhost:3000/api/reservations \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: test-12345" \
  -d '{
    "productId": "YOUR_PRODUCT_ID",
    "warehouseId": "YOUR_WAREHOUSE_ID",
    "quantity": 1
  }'

# Run SAME command again
# Expected: Same response, but with X-Idempotency-Replay: true header
# NO duplicate reservation created!
```

## Common Commands

```bash
# Development
npm run dev              # Start dev server
npm run build            # Build for production
npm start                # Start production server

# Database
npm run db:seed          # Seed with sample data
npm run db:studio        # Open Prisma Studio (visual DB editor)
npx prisma db push       # Push schema changes to DB
npx prisma generate      # Regenerate Prisma Client

# Testing
curl http://localhost:3000/api/products           # List products
curl http://localhost:3000/api/warehouses         # List warehouses
curl http://localhost:3000/api/cron/expire-reservations  # Trigger expiry
```

## Troubleshooting

### "Failed to fetch products"

**Cause**: Database connection issue

**Fix**:
1. Verify `DATABASE_URL` in `.env` is correct
2. Test connection:
   ```bash
   npx prisma db push
   ```
   Should succeed without errors

### "Redis connection failed"

**Cause**: Upstash credentials incorrect

**Fix**:
1. Double-check `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`
2. Ensure no extra quotes or spaces
3. Verify at https://console.upstash.com → Your Database → REST API

### No products showing

**Cause**: Database not seeded

**Fix**:
```bash
npm run db:seed
```

### "Lock acquisition failed" (503 error)

**Cause**: Redis is down or overloaded

**Fix**:
1. Check Upstash dashboard: https://console.upstash.com
2. Verify Redis database is active
3. If persistent, increase retry limit in `lib/redis.ts` (line 32)

### TypeScript errors after schema change

```bash
# Regenerate Prisma Client
npx prisma generate

# Restart dev server
npm run dev
```

## Deploy to Production (Vercel)

### Option 1: GitHub Integration (Recommended)

1. **Push to GitHub**:
   ```bash
   git init
   git add .
   git commit -m "feat: inventory reservation system"
   git branch -M main
   git remote add origin <your-github-url>
   git push -u origin main
   ```

2. **Connect to Vercel**:
   - Go to https://vercel.com/new
   - Import your GitHub repository
   - Framework preset: **Next.js** (auto-detected)

3. **Add Environment Variables** in Vercel:
   ```
   DATABASE_URL=postgresql://...
   UPSTASH_REDIS_REST_URL=https://...
   UPSTASH_REDIS_REST_TOKEN=...
   NEXT_PUBLIC_RESERVATION_TIMEOUT_MINUTES=10
   VERCEL_CRON_SECRET=<your-secret>
   ```

4. **Deploy**: Click "Deploy"

5. **Seed Production DB**:
   ```bash
   # Temporarily update .env to point to production DATABASE_URL
   npm run db:seed
   ```

6. **Verify Cron Job**:
   - Vercel Dashboard → Your Project → **Cron Jobs**
   - Should see: `GET /api/cron/expire-reservations` scheduled `*/5 * * * *`

### Option 2: Vercel CLI

```bash
# Install Vercel CLI
npm i -g vercel

# Login
vercel login

# Deploy
vercel

# Add environment variables (prompted during deploy)
# Or add manually:
vercel env add DATABASE_URL
vercel env add UPSTASH_REDIS_REST_URL
vercel env add UPSTASH_REDIS_REST_TOKEN
vercel env add NEXT_PUBLIC_RESERVATION_TIMEOUT_MINUTES
vercel env add VERCEL_CRON_SECRET

# Deploy to production
vercel --prod
```

## Next Steps

- ✅ Read [README.md](README.md) for comprehensive documentation
- ✅ Read [ARCHITECTURE.md](ARCHITECTURE.md) for technical deep-dive
- ✅ Read [TESTING_GUIDE.md](TESTING_GUIDE.md) for detailed test scenarios
- ✅ Explore the codebase:
  - `app/api/reservations/route.ts` - Core reservation logic with distributed locking
  - `lib/redis.ts` - Distributed lock implementation
  - `app/reservation/[id]/page.tsx` - Countdown timer & UI logic

## Support

For issues:
1. Check [README.md](README.md) troubleshooting section
2. Review code comments in relevant files
3. Open an issue on GitHub

---

**Happy coding! 🚀**
