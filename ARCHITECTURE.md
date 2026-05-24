# System Architecture

Comprehensive technical architecture for the Allo Inventory Reservation System.

## High-Level Overview

```
┌─────────────────────────────────────────────────────────────┐
│                         Client (Browser)                     │
│              React Components + Countdown Timers             │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTPS
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                    Next.js App Router (Vercel)               │
│  ┌────────────────┐              ┌─────────────────────┐    │
│  │ Pages (React)  │◄────────────►│   API Routes        │    │
│  │ - Product List │              │   - /products       │    │
│  │ - Reservation  │              │   - /reservations   │    │
│  └────────────────┘              │   - /cron/expire    │    │
│                                   └──────────┬──────────┘    │
└──────────────────────────────────────────────┼──────────────┘
                                               │
                   ┌───────────────────────────┼───────────────────────┐
                   │                           │                       │
                   ▼                           ▼                       ▼
          ┌────────────────┐         ┌─────────────────┐     ┌────────────────┐
          │  PostgreSQL    │         │  Redis/Upstash  │     │  Vercel Cron   │
          │  (Supabase)    │         │  (Distributed   │     │  (Every 5 min) │
          │                │         │   Locking +     │     │                │
          │  - Products    │         │  Idempotency)   │     │  Auto-expire   │
          │  - Warehouses  │         │                 │     │  reservations  │
          │  - Stock       │         └─────────────────┘     └────────────────┘
          │  - Reservations│
          │  - Idempotency │
          └────────────────┘
```

## Component Architecture

### 1. Frontend Layer (React + Next.js)

**Location**: `app/page.tsx`, `app/reservation/[id]/page.tsx`

**Responsibilities**:
- Display products with real-time stock availability
- Handle reservation creation via API calls
- Show live countdown timers using client-side hooks
- Display user-friendly errors (409 Conflict, 410 Gone)
- Optimistic UI updates for better UX

**Key Features**:
- **Client Components** (`'use client'`) for interactivity
- **Server Components** (default) for initial data fetching
- **Real-time countdown** using custom `useCountdown` hook
- **Error boundaries** for graceful failure handling
- **Responsive design** with Tailwind CSS

**Data Flow**:
```
User Action → API Call → Loading State → Success/Error → UI Update
```

### 2. API Layer (Next.js App Router)

**Location**: `app/api/**/*.ts`

#### Endpoints

| Method | Path | Purpose | Special Features |
|--------|------|---------|------------------|
| GET | `/api/products` | List products with per-warehouse stock | Computed `availableUnits` |
| GET | `/api/warehouses` | List all warehouses | Simple query |
| POST | `/api/reservations` | Create reservation | **Distributed locking**, idempotency |
| POST | `/api/reservations/:id/confirm` | Confirm purchase | **Idempotent**, expiry check |
| POST | `/api/reservations/:id/release` | Cancel reservation | Stock return |
| GET | `/api/cron/expire-reservations` | Expire old reservations | Cron-only (auth required) |

#### Request Flow (Reservation Creation)

```
1. Request arrives with JSON body
   ↓
2. Parse & validate input (Zod schema)
   ↓
3. Check Idempotency-Key header
   ↓
4. If key exists → Return cached response
   ↓
5. If key new → Proceed to business logic
   ↓
6. Acquire distributed lock (Redis)
   - Lock key: lock:reservation:{productId}:{warehouseId}
   - Retry up to 20 times (50ms delay)
   ↓
7. Read current stock (Prisma)
   ↓
8. Calculate available = totalUnits - reservedUnits
   ↓
9. Check availability >= quantity
   - If NO → Return 409 Conflict
   - If YES → Proceed
   ↓
10. Create reservation + increment reservedUnits (transaction)
    ↓
11. Release lock (Redis)
    ↓
12. Store idempotency response (24h TTL)
    ↓
13. Return 201 Created
```

### 3. Data Layer (Prisma + PostgreSQL)

**Schema Design**:

```prisma
model Product {
  id          String   @id @default(cuid())
  name        String
  sku         String   @unique
  price       Int      // in cents (e.g., 12999 = $129.99)
  description String?
  stock       Stock[]
  reservations Reservation[]
}

model Warehouse {
  id      String   @id @default(cuid())
  name    String
  location String?
  stock   Stock[]
  reservations Reservation[]
}

model Stock {
  id            String    @id @default(cuid())
  productId     String
  warehouseId   String
  totalUnits    Int       // Physical inventory
  reservedUnits Int       @default(0)  // Currently reserved (not confirmed)
  
  product   Product   @relation(fields: [productId], references: [id])
  warehouse Warehouse @relation(fields: [warehouseId], references: [id])
  
  @@unique([productId, warehouseId])
  @@index([productId])
  @@index([warehouseId])
}

model Reservation {
  id          String   @id @default(cuid())
  productId   String
  warehouseId String
  quantity    Int
  status      ReservationStatus  @default(PENDING)
  expiresAt   DateTime
  createdAt   DateTime @default(now())
  
  product   Product   @relation(fields: [productId], references: [id])
  warehouse Warehouse @relation(fields: [warehouseId], references: [id])
  
  @@index([status])
  @@index([expiresAt])
  @@index([productId, warehouseId])
}

enum ReservationStatus {
  PENDING    // Awaiting payment
  CONFIRMED  // Payment succeeded, permanent sale
  RELEASED   // User cancelled or payment failed
  EXPIRED    // Timeout reached without confirmation
}

model IdempotencyKey {
  id          String   @id @default(cuid())
  key         String   @unique
  requestPath String
  requestBody Json
  response    Json
  statusCode  Int
  createdAt   DateTime @default(now())
  expiresAt   DateTime
  
  @@index([expiresAt])
}
```

**Key Relationships**:
- **Product ↔ Stock ↔ Warehouse**: Many-to-many through Stock junction table
- **Stock uniqueness**: One Stock entry per (Product, Warehouse) pair
- **Computed availability**: `availableUnits = totalUnits - reservedUnits` (calculated at query time)

**Indexes for Performance**:
- `Stock.productId_warehouseId` - Unique composite for fast lookups
- `Reservation.status` - For filtering PENDING reservations in cron
- `Reservation.expiresAt` - For expiry queries
- `IdempotencyKey.key` - Unique for fast duplicate detection

### 4. Caching & Locking Layer (Redis/Upstash)

**Purpose**: Distributed locking for concurrency control

#### Implementation: DistributedLock Class

**Location**: `lib/redis.ts`

```typescript
class DistributedLock {
  // Lock acquisition with SET NX (Set if Not eXists)
  async acquire() {
    const result = await redis.set(lockKey, lockValue, { 
      nx: true,   // Only set if key doesn't exist
      px: ttl     // Auto-expire after TTL milliseconds
    });
    return result === "OK";
  }

  // Lock release with Lua script (atomic check + delete)
  async release() {
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    await redis.eval(script, [lockKey], [lockValue]);
  }

  // Convenience wrapper
  static async withLock(lockKey, fn, ttl = 10000) {
    const lock = new DistributedLock(lockKey, ttl);
    const acquired = await lock.acquire();
    if (!acquired) throw new Error("Failed to acquire lock");
    
    try {
      return await fn();
    } finally {
      await lock.release();
    }
  }
}
```

**Lock Properties**:
- **Key format**: `lock:reservation:{productId}:{warehouseId}`
- **TTL**: 10 seconds (prevents deadlocks if process crashes)
- **Retry logic**: 20 attempts × 50ms = 1 second max wait
- **Ownership check**: Lua script ensures only lock owner can release

## Concurrency Control Deep Dive

### The Problem: Race Condition

```
Scenario: Last unit of a product, two customers click "Reserve" simultaneously

Time    │ Request A                    │ Request B
────────┼──────────────────────────────┼────────────────────────────
t0      │ Read stock: 1 available      │
t1      │                              │ Read stock: 1 available
t2      │ Check: 1 >= 1 ✓             │
t3      │                              │ Check: 1 >= 1 ✓
t4      │ Reserve 1 unit               │
t5      │                              │ Reserve 1 unit
────────┴──────────────────────────────┴────────────────────────────
Result: ❌ OVERSOLD - 2 reservations created for 1 unit!
```

### The Solution: Distributed Locks

```
Time    │ Request A                    │ Request B
────────┼──────────────────────────────┼────────────────────────────
t0      │ Acquire lock ✓              │
t1      │ Read stock: 1 available      │ Acquire lock ❌ (locked by A)
t2      │ Check: 1 >= 1 ✓             │ Retry... ❌
t3      │ Reserve 1 unit               │ Retry... ❌
t4      │ Update: reservedUnits = 1    │ Retry... ❌
t5      │ Release lock                 │ Retry... ❌
t6      │                              │ Acquire lock ✓
t7      │                              │ Read stock: 0 available
t8      │                              │ Check: 0 >= 1 ❌
t9      │                              │ Return 409 Conflict
────────┴──────────────────────────────┴────────────────────────────
Result: ✅ CORRECT - Exactly one success, one failure!
```

**Guarantees Provided**:

1. **Mutual Exclusion**: Only one request processes a product-warehouse pair at a time
2. **Deadlock Freedom**: TTL ensures orphaned locks auto-release
3. **Atomicity**: Prisma transactions ensure reservation + stock update happen together or not at all
4. **Correctness**: Second request sees updated stock levels

### Why Distributed Locks over Database Locks?

| Approach | Pros | Cons | Chosen? |
|----------|------|------|---------|
| **Redis Distributed Lock** | Fast (in-memory), doesn't hold DB connections, scales horizontally | Requires Redis infra | ✅ **Yes** |
| `SELECT FOR UPDATE` (pessimistic) | Simple, ACID guarantees | Holds DB connections, doesn't scale across servers | ❌ No |
| Optimistic locking (version field) | No locks needed | Many retries under high contention, complex logic | ❌ No |

## Idempotency Implementation

### The Problem: Network Retries

```
Client          Network         Server          Database
  │                │               │                │
  │─── POST ──────►│               │                │
  │                │───────────────►│                │
  │                │               │─── INSERT ────►│
  │                │               │◄─── OK ────────│
  │                │◄─── 201 ───────│                │
  │◄─ TIMEOUT ────│ (packet lost) │                │
  │                │               │                │
  │─── RETRY ─────►│               │                │
  │                │───────────────►│                │
  │                │               │─── INSERT ────►│ ❌ Duplicate!
```

### The Solution: Idempotency Keys

**Client sends unique key**:
```http
POST /api/reservations
Content-Type: application/json
Idempotency-Key: reserve-abc123-xyz

{ "productId": "...", "warehouseId": "...", "quantity": 1 }
```

**Server logic**:
```typescript
1. Check: SELECT * FROM IdempotencyKey WHERE key = 'reserve-abc123-xyz'
2. If exists:
   → Return cached response (same status + body)
   → Add header: X-Idempotency-Replay: true
3. If not exists:
   → Execute business logic
   → Store: INSERT INTO IdempotencyKey (key, response, statusCode, expiresAt)
   → Return fresh response
```

**Properties**:
- **Uniqueness**: Key should be unique per operation (e.g., include user ID + timestamp)
- **TTL**: 24 hours (auto-cleanup via cron or DB trigger)
- **Applies to**: `POST /api/reservations` and `POST /api/reservations/:id/confirm`
- **Same response**: Identical status code and body for retries

## Reservation Lifecycle

```
                      POST /reservations
                             │
                             ▼
                       ┌──────────┐
                       │ PENDING  │ ← Timer starts (10 min default)
                       └─────┬────┘
                             │
             ┌───────────────┼───────────────┐
             │               │               │
        POST /confirm   Timer expires   POST /release
             │               │               │
             ▼               ▼               ▼
       ┌───────────┐   ┌─────────┐    ┌──────────┐
       │ CONFIRMED │   │ EXPIRED │    │ RELEASED │
       └───────────┘   └─────────┘    └──────────┘
             │               │               │
             │               └───────┬───────┘
             │                       │
       totalUnits -= qty      reservedUnits -= qty
       reservedUnits -= qty   (stock returned)
```

### State Transitions

| From | To | Trigger | Stock Impact |
|------|----|---------|-----------------------------|
| - | PENDING | POST /reservations | `reservedUnits += qty` |
| PENDING | CONFIRMED | POST /confirm | `totalUnits -= qty`, `reservedUnits -= qty` |
| PENDING | EXPIRED | Cron job (auto) | `reservedUnits -= qty` |
| PENDING | RELEASED | POST /release | `reservedUnits -= qty` |
| CONFIRMED | - | ❌ **Cannot transition** | - |
| EXPIRED | - | ❌ **Cannot transition** | - |
| RELEASED | - | ❌ **Cannot transition** | - |

### Expiry Mechanism

#### Production: Vercel Cron Job

**Configuration** (`vercel.json`):
```json
{
  "crons": [{
    "path": "/api/cron/expire-reservations",
    "schedule": "*/5 * * * *"  // Every 5 minutes
  }]
}
```

**Job Logic** (`app/api/cron/expire-reservations/route.ts`):
```typescript
1. Authenticate (check VERCEL_CRON_SECRET header)
2. Find expired: WHERE status = 'PENDING' AND expiresAt <= NOW()
3. Group by (productId, warehouseId) to batch stock updates
4. For each group:
   Transaction {
     a. UPDATE Reservation SET status = 'EXPIRED' WHERE id IN (...)
     b. UPDATE Stock SET reservedUnits -= totalQty WHERE (productId, warehouseId)
   }
5. Return count of expired reservations
```

**Why Cron over Real-time?**

| Approach | Latency | Complexity | Cost | Infrastructure | Chosen? |
|----------|---------|------------|------|----------------|---------|
| Vercel Cron | 5 min | Low | Free | None (serverless) | ✅ **Yes** |
| Background worker | < 1s | High | $$$ | Separate process | ❌ No |
| Redis TTL + pub/sub | 0s | Medium | $$ | Redis setup | ❌ No |
| Database triggers | 0s | Medium | Free | DB-specific | ❌ No |
| Lazy cleanup on read | Variable | Low | Free | None | Fallback only |

**Trade-off accepted**: 5-minute SLA is acceptable for this use case (vs. sub-second requirement for mission-critical systems).

#### Development: Manual Trigger

```bash
curl http://localhost:3000/api/cron/expire-reservations
```

## Security Considerations

### Implemented ✅

- **Cron authentication**: `Authorization: Bearer {VERCEL_CRON_SECRET}` header required
- **Input validation**: Zod schemas validate all API inputs
- **SQL injection prevention**: Prisma uses parameterized queries
- **Type safety**: TypeScript end-to-end catches type errors at compile time
- **Error handling**: Proper HTTP status codes (400, 404, 409, 410, 500, 503)

### Not Implemented (Future) ⚠️

- **Rate limiting**: Per-IP throttling to prevent abuse/DoS
- **CORS**: Currently allows all origins (fine for monolith, needs config for separate frontend)
- **Authentication**: No user login system (out of scope for this exercise)
- **Audit logs**: Track who reserved what when for compliance
- **Data encryption**: Encrypt sensitive fields at rest

## Performance Characteristics

### Expected Load

| Traffic Level | Reservations/min | Lock Contentions | Avg Lock Wait | DB Connections |
|---------------|------------------|------------------|---------------|----------------|
| Low | 10 | ~0 | 0ms | 2-5 |
| Medium | 100 | ~5/min | 50-200ms | 10-20 |
| High | 1000 | ~50/min | 500-1000ms | 50+ |

### Bottlenecks & Solutions

1. **Lock contention** (high-demand SKUs during flash sales)
   - **Symptom**: Increased 503 "System is busy" errors
   - **Fix**: Increase retry limit, add request queue (Bull/BullMQ)

2. **Database connections** (Prisma default pool: 10)
   - **Symptom**: "Too many connections" errors
   - **Fix**: Use Prisma Data Proxy or PgBouncer (connection pooler)

3. **Cron cold start** (Vercel serverless functions)
   - **Symptom**: First cron invocation each 5-min window is slow (~2s)
   - **Fix**: Keep-alive ping or migrate to dedicated worker

## Scalability Path

### Phase 1: Current (0-1K DAU)
- Vercel Hobby + Supabase Free + Upstash Free
- Single region (US/EU)
- No caching layer
- **Cost**: $0/month

### Phase 2: Growth (1K-10K DAU)
- Vercel Pro + Supabase Pro + Upstash Standard
- Add Redis cache for product reads (GET /api/products)
- Database connection pooling (PgBouncer)
- **Cost**: ~$55/month

### Phase 3: Scale (10K-100K DAU)
- Multi-region deployment (Vercel Edge Functions)
- Read replicas for product listings
- CDN for static assets (Vercel Edge Network)
- Queue-based reservation processing
- Real-time expiry via dedicated worker
- **Cost**: ~$500/month

### Phase 4: Enterprise (100K+ DAU)
- Microservices architecture
- Event-driven system (Kafka/RabbitMQ)
- Inventory sharding by warehouse
- ML-based demand forecasting
- Multi-region active-active setup
- **Cost**: $5K+/month

## Monitoring & Observability

### Key Metrics to Track

**Application**:
- Reservation success rate (target: >95%)
- Lock acquisition time (p50, p95, p99)
- API latency per endpoint
- Error rates by status code (409, 410, 503)
- Idempotency replay rate

**Infrastructure**:
- Database connection pool usage
- Redis memory usage
- Vercel function cold starts
- Cron job execution time

**Business**:
- Conversion rate (reservations → confirmations)
- Abandonment rate (expired reservations %)
- Stock turnover per warehouse
- Average time to confirmation

### Recommended Tools

- **APM**: Sentry (errors), Datadog (metrics)
- **Logs**: Vercel Logs, Axiom, Better Stack
- **Metrics**: Prometheus + Grafana
- **Alerts**: PagerDuty, Opsgenie, Discord webhooks

## Testing Strategy

### Unit Tests (Future)
```typescript
// lib/redis.test.ts
test('Lock prevents concurrent execution', async () => {
  let counter = 0;
  const increment = () => { counter++; };
  
  await Promise.all([
    DistributedLock.withLock('test', increment),
    DistributedLock.withLock('test', increment),
  ]);
  
  expect(counter).toBe(2); // Sequential execution
});
```

### Integration Tests (Future)
```typescript
// app/api/reservations/route.test.ts
test('Concurrent reservations for last unit', async () => {
  const [res1, res2] = await Promise.all([
    POST('/api/reservations', { productId, warehouseId, quantity: 1 }),
    POST('/api/reservations', { productId, warehouseId, quantity: 1 }),
  ]);
  
  const statuses = [res1.status, res2.status].sort();
  expect(statuses).toEqual([201, 409]); // One success, one conflict
});
```

### Load Tests (Future)
```javascript
// k6 script
export default function() {
  http.post('https://your-app.vercel.app/api/reservations', {
    productId: 'prod_123',
    warehouseId: 'wh_1',
    quantity: 1
  });
}
```

## Disaster Recovery

### Failure Scenarios

| Failure | Impact | Recovery | Prevention |
|---------|--------|----------|------------|
| Redis down | Lock failures (503) | Fallback to DB locks | Redis clustering |
| Database down | All requests fail | Use read replica | Connection pooling |
| Cron doesn't run | Reservations don't expire | Manual API trigger | Monitor cron logs |
| Lock orphaned | Stock temporarily blocked | TTL auto-releases (10s) | Shorter TTL |

### Backup Strategy

- **Database**: Supabase automated daily backups
- **Manual snapshot**: `pg_dump` before schema changes
- **Restore**: Supabase dashboard or `pg_restore` command

---

**Last Updated**: May 2026  
**Author**: Built for Allo Health Engineering Interview
