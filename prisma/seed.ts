import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Starting database seed...");

  // Clean existing data
  await prisma.idempotencyKey.deleteMany();
  await prisma.reservation.deleteMany();
  await prisma.stock.deleteMany();
  await prisma.product.deleteMany();
  await prisma.warehouse.deleteMany();

  // Create warehouses
  const warehouse1 = await prisma.warehouse.create({
    data: {
      name: "Mumbai Central",
      location: "Mumbai, Maharashtra",
    },
  });

  const warehouse2 = await prisma.warehouse.create({
    data: {
      name: "Delhi NCR",
      location: "Gurugram, Haryana",
    },
  });

  const warehouse3 = await prisma.warehouse.create({
    data: {
      name: "Bangalore Tech Park",
      location: "Bangalore, Karnataka",
    },
  });

  console.log("✅ Created warehouses");

  // Create products
  const products = await Promise.all([
    prisma.product.create({
      data: {
        name: "Wireless Headphones Pro",
        description:
          "Premium noise-cancelling wireless headphones with 30-hour battery life",
        sku: "WHP-001",
        price: 12999.0,
        imageUrl: "https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=500",
      },
    }),
    prisma.product.create({
      data: {
        name: "Smart Watch Ultra",
        description:
          "Advanced fitness tracking smartwatch with GPS and heart rate monitor",
        sku: "SWU-002",
        price: 24999.0,
        imageUrl: "https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=500",
      },
    }),
    prisma.product.create({
      data: {
        name: "Portable Bluetooth Speaker",
        description:
          "Waterproof portable speaker with 360-degree sound and 20-hour playtime",
        sku: "PBS-003",
        price: 5999.0,
        imageUrl: "https://images.unsplash.com/photo-1608043152269-423dbba4e7e1?w=500",
      },
    }),
    prisma.product.create({
      data: {
        name: "USB-C Fast Charger",
        description: "65W GaN fast charger with dual USB-C ports and foldable plug",
        sku: "UFC-004",
        price: 2499.0,
        imageUrl: "https://images.unsplash.com/photo-1591290619762-d06e48c0a079?w=500",
      },
    }),
    prisma.product.create({
      data: {
        name: "Wireless Mouse Ergonomic",
        description:
          "Ergonomic wireless mouse with precision tracking and long battery life",
        sku: "WME-005",
        price: 1899.0,
        imageUrl: "https://images.unsplash.com/photo-1527814050087-3793815479db?w=500",
      },
    }),
    prisma.product.create({
      data: {
        name: "Mechanical Keyboard RGB",
        description:
          "Premium mechanical keyboard with customizable RGB lighting and hot-swappable switches",
        sku: "MKR-006",
        price: 8999.0,
        imageUrl: "https://images.unsplash.com/photo-1587829741301-dc798b83add3?w=500",
      },
    }),
  ]);

  console.log("✅ Created products");

  // Create stock for each product in each warehouse
  const stockData = [];
  for (const product of products) {
    stockData.push(
      {
        productId: product.id,
        warehouseId: warehouse1.id,
        totalUnits: Math.floor(Math.random() * 50) + 10, // 10-60 units
        reservedUnits: 0,
      },
      {
        productId: product.id,
        warehouseId: warehouse2.id,
        totalUnits: Math.floor(Math.random() * 50) + 10,
        reservedUnits: 0,
      },
      {
        productId: product.id,
        warehouseId: warehouse3.id,
        totalUnits: Math.floor(Math.random() * 50) + 10,
        reservedUnits: 0,
      }
    );
  }

  await prisma.stock.createMany({
    data: stockData,
  });

  console.log("✅ Created stock levels");

  // Add some special cases for testing
  await prisma.stock.updateMany({
    where: {
      productId: products[0].id,
      warehouseId: warehouse1.id,
    },
    data: {
      totalUnits: 2, // Low stock for testing race conditions
    },
  });

  await prisma.stock.updateMany({
    where: {
      productId: products[1].id,
      warehouseId: warehouse2.id,
    },
    data: {
      totalUnits: 1, // Very low stock for testing
    },
  });

  console.log("✅ Added special test cases");
  console.log("🎉 Seed completed successfully!");
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
