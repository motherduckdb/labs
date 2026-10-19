"""Generate the CSV fixtures published in the fixtures repo (deterministic, seed 7).

    python scenarios/fixtures/make_fixtures.py <fixtures-repo-checkout>

fixtures/products.csv         baseline products (sku, name, category, price)
fixtures/v2/products.csv      S08: upstream renamed price -> unit_price
fixtures/orders.csv           baseline 50 orders, updated_at in September
fixtures/orders_resent.csv    S09: upstream re-sends 20 existing orders with a newer updated_at (status change)
fixtures/orders_nulls.csv     S10: 20 new orders, 8 of them with a NULL customer_id
"""
import csv, pathlib, random, sys

out = pathlib.Path(sys.argv[1]) / "fixtures"
(out / "v2").mkdir(parents=True, exist_ok=True)
rnd = random.Random(7)
products = [("SKU-%03d" % i, n, c, p) for i, (n, c, p) in enumerate([
    ("Duck Mug", "kitchen", 12.50), ("Quack Hoodie", "apparel", 48.00), ("Parquet Coaster Set", "kitchen", 9.99),
    ("SQL Sticker Pack", "office", 4.25), ("Lakehouse Poster", "office", 18.00), ("Duck Socks", "apparel", 11.00),
    ("Columnar Notebook", "office", 7.75), ("Vector Tote", "apparel", 21.50)], start=1)]


def write(path, header, rows):
    with open(path, "w", newline="") as f:
        w = csv.writer(f); w.writerow(header); w.writerows(rows)


write(out / "products.csv", ["sku", "name", "category", "price"], products)
write(out / "v2/products.csv", ["sku", "name", "category", "unit_price"], products)
orders = [(i, rnd.randint(100, 140), rnd.choice(products)[0], rnd.randint(1, 5), "placed",
           f"2026-09-{1 + i % 28:02d}T{8 + i % 10:02d}:00:00Z") for i in range(1, 51)]
H = ["order_id", "customer_id", "sku", "qty", "status", "updated_at"]
write(out / "orders.csv", H, orders)
resent = list(orders) + [(o[0], o[1], o[2], o[3], "shipped", f"2026-10-{10 + j % 5:02d}T12:00:00Z")
                         for j, o in enumerate(rnd.sample(orders, 20))]
write(out / "orders_resent.csv", H, resent)
new = [(i, "" if i % 5 in (1, 3) and i < 71 else rnd.randint(100, 140), rnd.choice(products)[0], rnd.randint(1, 5),
        "placed", f"2026-10-12T{(i - 50) % 24:02d}:00:00Z") for i in range(51, 71)]
write(out / "orders_nulls.csv", H, list(orders) + new)
print("nulls:", sum(1 for r in new if r[1] == ""), "resent dupes:", 20)
