# Allo Inventory & Reservation System

A production-ready multi-warehouse inventory reservation platform built with Next.js, featuring race-condition-free reservation logic, distributed locking, and automatic expiry handling.

## 🎯 Overview

This system solves the critical race condition problem in e-commerce checkout flows: when a customer proceeds to payment (which can take several minutes), we temporarily reserve inventory units to prevent overselling, while ensuring abandoned carts don't unnecessarily deplete available stock.

### Key Features

- ✅ **Race-condition-free reservations** using Redis distributed locks
- ✅ **Idempotent API endpoints** for safe retries
- ✅ **Automatic reservation expiry** via Vercel Cron
- ✅ **Multi-warehouse inventory tracking** with real-time availability
- ✅ **Live countdown timers** on reservation pages
- ✅ **Production-ready architecture** with PostgreSQL and Redis
- ✅ **Comprehensive error handling** (409 Conflict, 410 Gone)

## 🏗️ Architecture

### Tech Stack

- **Framework**: Next.js 15 with App Router
- **Language**: TypeScript (end-to-end type safety)
- **Database**: PostgreSQL (via Supabase/Neon)
- **ORM**: Prisma
- **Caching/Locking**: Redis (Upstash)
- **Validation**: Zod
- **UI**: Tailwind CSS + Custom Components
- **Hosting**: Vercel

### Data Model

```prisma
Warehouse ──┐
            ├──> Stock <── Product
            │
Reservation ┴
```

- **Products**: SKU, name, price, description
- **Warehouses**: Multi-location inventory management
- **Stock**: Per-product-per-warehouse inventory tracking
  - `totalUnits`: Physical inventory
  - `reservedUnits`: Currently reserved (not yet confirmed)
  - Available = `totalUnits - reservedUnits`
- **Reservations**: Time-limited holds on inventory
  - Status: `PENDING`, `CONFIRMED`, `RELEASED`, `EXPIRED`
  - Auto-expire after 10 minutes (configurable)
- **IdempotencyKey**: Deduplication for safe API retries

## 🔒 Concurrency Control

The core challenge: **Two customers clicking "Reserve" simultaneously for the last unit**.

### Solution: Distributed Locks via Redis

```typescript
await DistributedLock.withLock(`reservation:${productId}:${warehouseId}`, async () => {
  // 1. Read current stock
  const available = stock.totalUnits - stock.reservedUnits;
  
  // 2. Check availability
  if (available < quantity) {
    return 409; // Conflict
  }
  
  // 3. Create reservation + increment reserved units (atomic transaction)
  await prisma.$transaction([
    prisma.reservation.create({ ... }),
    prisma.stock.update({ 
      data: { reservedUnits: { increment: quantity } }
    })
  ]);
});
```

**How it works:**

1. **Lock acquisition**: Only one request can hold the lock for a product-warehouse pair
2. **Retry mechanism**: Failed requests retry for up to 1 second (20 attempts × 50ms)
3. **Atomic updates**: Prisma transactions ensure reservation + stock update happen together
4. **Lock release**: Automatic cleanup via TTL (10 seconds) and explicit release

**Correctness guarantee**: If two requests race for the last unit, exactly one succeeds with a reservation; the other gets `409 Conflict`.

## 🔄 Idempotency

Network failures and retries are inevitable. Idempotent endpoints prevent duplicate reservations.

### Implementation

```typescript
// Client sends unique key
headers: {
  'Idempotency-Key': 'reserve-12345-abc'
}

// Server caches response for 24 hours
if (existingRequest) {
  return cachedResponse; // Same status + body
}

// Execute + store
const response = await createReservation();
await storeIdempotencyResponse(key, response);
```

**Applied to**:
- `POST /api/reservations` (reserve)
- `POST /api/reservations/:id/confirm` (confirm purchase)

**Benefit**: Client can safely retry on network timeout without creating duplicate reservations.

## ⏰ Reservation Expiry

### The Problem

Reservations hold inventory. If a customer abandons checkout, those units must return to available stock.

### Solution: Vercel Cron + Lazy Cleanup

**Primary mechanism: Vercel Cron** (production)

```json
// vercel.json
{
  "crons": [{
    "path": "/api/cron/expire-reservations",
    "schedule": "*/5 * * * *"  // Every 5 minutes
  }]
}
```

The cron job:
1. Finds all `PENDING` reservations where `expiresAt <= now()`
2. Batch updates them to `EXPIRED` status
3. Decrements `reservedUnits` to return stock to availability
4. Runs in a transaction for atomicity

**Secondary mechanism: Client-side checks**

- Countdown timer shows live expiry
- Frontend displays errors on expired reservations
- API endpoints validate expiry before confirm/release

### Trade-offs

| Approach | Pros | Cons | Used? |
|----------|------|------|-------|
| Vercel Cron | Simple, reliable, serverless | 5-min granularity | ✅ **Yes** |
| Background worker | Real-time, precise | Requires separate process | ❌ No (overkill) |
| Lazy cleanup on read | Zero infrastructure | Delayed availability | ⚠️ Fallback only |

**Choice**: Vercel Cron strikes the best balance for this use case. 5-minute granularity is acceptable (vs. sub-second requirements), and it requires zero additional infrastructure.

## 📡 API Endpoints

### `GET /api/products`

List all products with per-warehouse availability.

**Response:**
```json
[{
  "id": "prod_123",
  "name": "Wireless Headphones",
  "sku": "WHP-001",
  "price": 12999,
  "stock": [{
    "warehouseId": "wh_1",
    "warehouse": { "name": "Mumbai Central" },
    "totalUnits": 50,
    "reservedUnits": 5,
    "availableUnits": 45
  }]
}]
```

### `POST /api/reservations`

Reserve units for a product-warehouse.

**Request:**
```json
{
  "productId": "prod_123",
  "warehouseId": "wh_1",
  "quantity": 1
}
```

**Headers:**
```
Idempotency-Key: reserve-abc123
```

**Success (201):**
```json
{
  "reservation": {
    "id": "res_xyz",
    "status": "PENDING",
    "expiresAt": "2026-05-24T10:15:00Z",
    "quantity": 1
  }
}
```

**Errors:**
- `409 Conflict`: Insufficient stock
- `400 Bad Request`: Invalid input
- `503 Service Unavailable`: Failed to acquire lock

### `POST /api/reservations/:id/confirm`

Confirm a reservation (payment succeeded).

**Headers:**
```
Idempotency-Key: confirm-abc123
```

**Success (200):**
```json
{
  "reservation": {
    "id": "res_xyz",
    "status": "CONFIRMED"
  }
}
```

**Errors:**
- `410 Gone`: Reservation expired
- `404 Not Found`: Reservation doesn't exist

**Effect**: 
- Sets status to `CONFIRMED`
- Decrements `totalUnits` (permanent sale)
- Decrements `reservedUnits` (release hold)

### `POST /api/reservations/:id/release`

Release a reservation early (user cancelled or payment failed).

**Success (200):**
```json
{
  "reservation": {
    "id": "res_xyz",
    "status": "RELEASED"
  }
}
```

**Effect**: 
- Sets status to `RELEASED`
- Decrements `reservedUnits` (return to available stock)

## 🚀 Setup Instructions

### Prerequisites

- Node.js 18+ and npm
- PostgreSQL database (hosted via Supabase/Neon)
- Redis instance (Upstash free tier)
- Vercel account (for deployment)

### 1. Clone and Install

```bash
git clone <repository-url>
cd allo-inventory-system
npm install
```

### 2. Environment Variables

Create `.env` file:

```env
# Database (Supabase/Neon)
DATABASE_URL="postgresql://user:password@host:5432/db?sslmode=require"

# Redis (Upstash)
UPSTASH_REDIS_REST_URL="https://your-redis.upstash.io"
UPSTASH_REDIS_REST_TOKEN="your-token"

# App Config
NEXT_PUBLIC_RESERVATION_TIMEOUT_MINUTES=10
VERCEL_CRON_SECRET="your-secret-key"
```

**Get credentials:**

- **Supabase**: https://supabase.com → New Project → Settings → Database → Connection String
- **Neon**: https://neon.tech → New Project → Connection String
- **Upstash**: https://upstash.com → New Database → REST API → Copy URL + Token

### 3. Database Setup

```bash
# Push schema to database
npx prisma db push

# Seed with sample data
npm run db:seed

# (Optional) Open Prisma Studio to inspect data
npm run db:studio
```

### 4. Run Development Server

```bash
npm run dev
```

Open http://localhost:3000

### 5. Deploy to Vercel

```bash
# Install Vercel CLI
npm i -g vercel

# Deploy
vercel

# Follow prompts to link project
# Add environment variables in Vercel dashboard
# Vercel will auto-deploy on git push
```

**Important**: Set all environment variables in Vercel project settings (Settings → Environment Variables).

## 📦 Project Structure

```
allo-inventory-system/
├── app/
│   ├── api/
│   │   ├── products/route.ts           # GET products with stock
│   │   ├── warehouses/route.ts         # GET warehouses
│   │   ├── reservations/
│   │   │   ├── route.ts                # POST reserve, GET all
│   │   │   └── [id]/
│   │   │       ├── confirm/route.ts    # POST confirm
│   │   │       └── release/route.ts    # POST release
│   │   └── cron/
│   │       └── expire-reservations/route.ts  # Cron job
│   ├── reservation/[id]/page.tsx       # Reservation detail page
│   ├── page.tsx                        # Product listing
│   ├── layout.tsx                      # Root layout
│   └── globals.css                     # Tailwind styles
├── components/ui/                      # Reusable UI components
├── lib/
│   ├── prisma.ts                       # Prisma client singleton
│   ├── redis.ts                        # Redis client + DistributedLock
│   ├── validations.ts                  # Zod schemas
│   └── utils.ts                        # Utility functions
├── prisma/
│   ├── schema.prisma                   # Database schema
│   └── seed.ts                         # Seed script
├── .env.example                        # Environment template
├── vercel.json                         # Vercel cron config
└── README.md                           # This file
```

## 🧪 Testing the System

### Test Race Conditions

1. **Open two browser tabs** to the same product with low stock (2 units)
2. Click "Reserve" **simultaneously** in both tabs
3. **Expected**: One succeeds, other gets "Insufficient stock" error

### Test Expiry

1. Create a reservation
2. Wait for countdown to reach 0:00
3. **Expected**: Page shows "Reservation Expired" error
4. After cron runs (max 5 min), check product listing → stock returned

### Test Idempotency

```bash
# Send same request twice with same idempotency key
curl -X POST http://localhost:3000/api/reservations \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: test-123" \
  -d '{"productId":"...","warehouseId":"...","quantity":1}'

# Second request returns cached response (check X-Idempotency-Replay header)
```

## 🔧 Configuration

### Reservation Timeout

Change expiry duration (default: 10 minutes):

```env
NEXT_PUBLIC_RESERVATION_TIMEOUT_MINUTES=15
```

### Cron Schedule

Edit `vercel.json`:

```json
{
  "crons": [{
    "schedule": "*/2 * * * *"  // Every 2 minutes
  }]
}
```

## 📊 Production Considerations

### What's Included

✅ Distributed locking for concurrency safety  
✅ Idempotency for safe retries  
✅ Database transactions for atomicity  
✅ Comprehensive error handling  
✅ TypeScript for type safety  
✅ Input validation with Zod  
✅ Indexed database queries  

### Trade-offs & Future Improvements

| Area | Current Approach | With More Time |
|------|-----------------|----------------|
| **Lock granularity** | Per product-warehouse | Per SKU globally (more contention) or row-level locks (Postgres `SELECT FOR UPDATE`) |
| **Expiry precision** | 5-minute cron | Real-time via background worker or Redis key expiry |
| **Stock allocation** | First-come-first-served | Priority queues, geo-based routing |
| **Monitoring** | Console logs | Structured logging (Datadog), APM (Sentry) |
| **Rate limiting** | None | Per-IP throttling to prevent abuse |
| **Cache layer** | None | Redis cache for product reads (99% read-heavy) |
| **Testing** | Manual | Unit tests (Jest), integration tests (Playwright), load tests (k6) |

### Why These Choices?

1. **Distributed locks over DB locks**: Redis is faster and doesn't hold DB connections
2. **Vercel Cron over workers**: Simpler ops, sufficient for 5-min SLA
3. **Optimistic over pessimistic locking**: Better performance under low contention
4. **Idempotency in DB over Redis**: Permanent audit trail, survives Redis restarts

## 🎓 Learning Outcomes

This implementation demonstrates:

- **Concurrency control patterns** in distributed systems
- **Idempotency** for reliable APIs
- **Transaction management** for data consistency
- **Time-based workflows** (expiry, crons)
- **Production-ready Next.js** architecture
- **Type-safe full-stack** development

## 📝 License

MIT

---

**Built with ❤️ for Allo Health Engineering Interview**
