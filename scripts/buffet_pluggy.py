"""buffet pluggy-sync: importa do Meu Pluggy o que é novo (docs/pluggy-sync.md).

classify() é pura: recebe o que veio do Pluggy e o que o banco já sabe e devolve um Plan. apply_plan() grava. O --dry-run para
entre os dois. Cada efeito vai no mesmo comando SQL que o registro em buffet_pluggy_seen, então repetir nunca conta duas vezes.

Segredos (client id, client secret, api key) e ids de item nunca são impressos, nem em mensagem de erro.
"""
import collections, dataclasses, datetime as dt, hashlib, json, os, re, sys, unicodedata, urllib.error, urllib.parse, urllib.request
from zoneinfo import ZoneInfo

TZ = ZoneInfo("America/Sao_Paulo")
API = "https://api.pluggy.ai"
CLIENT_ID_FILE = "/home/box/.pluggy-client-id"
ITEM_IDS_FILE = "/home/box/.pluggy-item-ids"
LEDGER = "public.buffet_pluggy_seen"
LOOKBACK_DAYS = 45                     # cobre o casamento de estorno (até 30 dias) e a demora do banco em publicar
DUP_DAYS = 3                           # "data próxima": mesma tolerância do import
BATCH = 200
NO_LEDGER = "erro: a migration 20261110190000_buffet_pluggy_sync.sql ainda não foi aplicada; sem ela só o --dry-run funciona"

# Palavras → categoria, na ordem do import. Comparadas por palavra inteira.
RULES = [
    ("Assinaturas", "netflix spotify|youtube premium|disney|hbo|max com|prime video|amazon prime|apple com bill|icloud|deezer|globoplay|paramount|crunchyroll|chatgpt|openai|google one|microsoft 365|claude|anthropic"),
    ("Outros", "mercado livre|mercadolivre|mercado pago|mercadopago|amazon|shopee|aliexpress|magalu|americanas|temu"),
    ("Jogos", "steam|playstation|psn|xbox|nintendo|epic games|riot|blizzard|google play|supercell"),
    ("Transporte", "uber|99app|99 pop|99pop|99 taxi|99|cabify|indrive|posto|shell|ipiranga|petrobras|combustivel|estacionamento|estapar|zona azul|metro|sptrans|bilhete unico|onibus|pedagio|sem parar|veloe|conectcar|latam|buser|clickbus"),
    ("Mercado", "supermercado|mercado|mercadinho|atacadao|assai|carrefour|pao de acucar|hortifruti|sacolao|minuto pa|dia brasil"),
    ("Alimentação", "ifood|ifd|rappi|restaurante|lanchonete|padaria|cafe|cafeteria|coffee|pizzaria|pizza|burger|mcdonalds|bk|subway|starbucks|acai|sorveteria|bar|boteco|sushi|confeitaria|doceria|pastelaria|food|lanches|grill"),
    ("Saúde", "farmacia|drogaria|drogasil|droga raia|raia|pague menos|panvel|hospital|clinica|laboratorio|odonto|dentista|unimed|otica"),
    ("Fitness", "academia|smart fit|smartfit|gympass|wellhub|crossfit|gym"),
    ("Pet", "petz|cobasi|petshop|pet shop|veterinaria|veterinario|petlove"),
    ("Telefonia e internet", "vivo|claro|tim|telefonica|telesp"),
    ("Vestimenta", "renner|riachuelo|cea|zara|hering|centauro|netshoes|shein|calcados|modas"),
    ("Educação", "udemy|alura|coursera|livraria|escola|faculdade|curso|colegio"),
    ("Lazer", "cinema|cinemark|ingresso|ingressos|sympla|eventim|teatro|museu"),
    ("Moradia", "aluguel|condominio|enel|sabesp|comgas|energia|saneamento|leroy merlin"),
    ("Impostos", "iptu|ipva|darf|detran|receita fed|prefeitura|simples nacional|das mei"),
]
# Categoria do Pluggy → categoria do Buffet. As genéricas (Shopping, Services, Transfers...) ficam de fora de propósito.
PLUGGY_CATEGORY = {
    "Eating out": "Alimentação", "Food delivery": "Alimentação", "Food and drinks": "Alimentação", "Groceries": "Mercado",
    "Taxi and ride-hailing": "Transporte", "Public transportation": "Transporte", "Transportation": "Transporte",
    "Tolls and in vehicle payment": "Transporte", "Gas stations": "Transporte", "Vehicle maintenance": "Transporte",
    "Gas": "Moradia", "Housing": "Moradia", "Electricity": "Moradia", "Houseware": "Moradia",
    "Telecommunications": "Telefonia e internet", "Mobile": "Telefonia e internet", "Internet": "Telefonia e internet",
    "Digital services": "Assinaturas", "Music streaming": "Assinaturas", "Gaming": "Jogos", "Gambling": "Jogos",
    "Gyms and fitness centers": "Fitness", "Wellness and fitness": "Fitness", "Wellness": "Saúde",
    "Healthcare": "Saúde", "Pharmacy": "Saúde", "Dentist": "Saúde", "Hospital clinics and labs": "Saúde",
    "Pet supplies and vet": "Pet", "Clothing": "Vestimenta", "School": "Educação", "Education": "Educação", "Bookstore": "Educação",
    "Leisure": "Lazer", "Cinema, theater and concerts": "Lazer", "Tickets": "Lazer", "Accomodation": "Lazer", "Travel": "Lazer",
    "Tax on financial operations": "Impostos",
}
INSTALLMENT_SUFFIX = re.compile(r"\s+\d{1,2}/\d{1,2}$")


# ---------------------------------------------------------------- utilidades puras
def local_date(iso):
    return dt.datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(TZ).date()


def parse_ts(v):
    return dt.datetime.fromisoformat(str(v).replace("Z", "+00:00"))


def fold(s):
    return unicodedata.normalize("NFD", str(s or "")).encode("ascii", "ignore").decode().lower()


def tokens(s):
    return re.sub(r"[^a-z0-9]+", " ", fold(s)).split()


def cents(v):
    return round(abs(float(v)) * 100)


def rule_category(desc):
    t = tokens(desc)
    for cat, words in RULES:
        for w in words.split("|"):
            w = w.split()
            if any(t[i:i + len(w)] == w for i in range(len(t) - len(w) + 1)):
                return cat
    return None


def clean_merchant(desc):
    parts = [p.strip() for p in desc.split("|")]
    m = parts[-1] if len(parts) > 1 and parts[-1] else parts[0]
    m = INSTALLMENT_SUFFIX.sub("", m).strip()
    return (m.title() if m.isupper() else m) or "Sem descrição"


def raw_key(desc):
    """Chave da descrição crua do banco, sem o k/n da parcela: liga um gasto novo ao que já foi renomeado no Buffet."""
    return " ".join(tokens(INSTALLMENT_SUFFIX.sub("", desc[:80].strip())))


def key_from_note(note):
    body = re.sub(r"^pluggy( · pendente)? · ", "", note or "")
    return raw_key(body.split(" · parcela ")[0])


def plan_id(x):
    """Mesmo hash do import: o plano de uma compra parcelada é o mesmo em qualquer sincronização."""
    md = x.get("creditCardMetadata") or {}
    purchase = md.get("purchaseDate") or md.get("transactionDateTime") or x["date"]
    key = (INSTALLMENT_SUFFIX.sub("", x["description"]).strip(), purchase[:19], md.get("totalInstallments"), md.get("cardNumber"))
    return "pluggy-plan-" + hashlib.sha1(repr(key).encode()).hexdigest()[:16]


def bill_month_of(cy, d):
    """Fatura (mês de vencimento) de uma compra na data, pelo ciclo. Espelho de public.buffet_bill_month."""
    closing, due = cy
    n = d.year * 12 + d.month - 1 + (0 if d.day < closing else 1) + (0 if due > closing else 1)
    return f"{n // 12}-{n % 12 + 1:02d}"


def next_due_month(cy, d):
    """Fatura que um pagamento feito na data quita, quando o Pluggy ainda não lista a fatura: o próximo vencimento."""
    n = d.year * 12 + d.month - 1 + (0 if d.day <= cy[1] else 1)
    return f"{n // 12}-{n % 12 + 1:02d}"


def shift_month(mk, delta):
    y, m = map(int, mk.split("-"))
    n = y * 12 + m - 1 + delta
    return f"{n // 12}-{n % 12 + 1:02d}"


# ---------------------------------------------------------------- planejamento (puro)
@dataclasses.dataclass
class Ctx:
    today: dt.date
    categories: list
    known: set                         # ids já em buffet_transactions ou buffet_card_payments
    ledger: dict                       # id → {"outcome", "paired_with"} de buffet_pluggy_seen
    import_at: object = None           # fim do import inicial; só vale enquanto o ledger está vazio
    candidates: list = dataclasses.field(default_factory=list)   # lançamentos que não vieram do Pluggy
    manual_payments: list = dataclasses.field(default_factory=list)
    learned: dict = dataclasses.field(default_factory=dict)
    debts: set = dataclasses.field(default_factory=set)
    receivable: list = dataclasses.field(default_factory=list)   # centavos a receber em aberto
    cycles: dict = dataclasses.field(default_factory=dict)       # banco → (fecha, vence)

    @property
    def first_run(self):
        return not self.ledger


@dataclasses.dataclass
class Plan:
    expenses: list = dataclasses.field(default_factory=list)
    debts: dict = dataclasses.field(default_factory=dict)
    payments: list = dataclasses.field(default_factory=list)
    incomes: list = dataclasses.field(default_factory=list)
    refunds: list = dataclasses.field(default_factory=list)
    marks: list = dataclasses.field(default_factory=list)        # ledger sem outro efeito
    counts: collections.Counter = dataclasses.field(default_factory=collections.Counter)
    skipped: collections.Counter = dataclasses.field(default_factory=collections.Counter)


def learn_rows(rows):
    """{chave crua: como o usuário deixou}, de linhas já importadas, as mais recentes primeiro. Vale o nome mais frequente,
    para um renome pontual não virar o nome de todas as próximas corridas."""
    groups = collections.defaultdict(list)
    for r in rows:
        k = key_from_note(r.get("note"))
        if k:
            groups[k].append(r)
    learned = {}
    for k, rs in groups.items():
        cats = collections.Counter(r["category"] for r in rs)
        last = next((r for r in rs if not r.get("debt_id")), None)
        learned[k] = {"merchant": collections.Counter(r["merchant"] for r in rs).most_common(1)[0][0],
                      "category": cats.most_common(1)[0][0],
                      "share": last.get("split_share_pct") if last else None}
    return learned


def choose_category(x, ctx):
    """Aprendido > regra de Pet/Impostos > categoria do Pluggy > regra por palavra > Outros. Só categoria da lista do usuário."""
    learned = ctx.learned.get(raw_key(x["description"])) or {}
    rule = rule_category(x["description"])
    if learned.get("category") not in (None, "Outros"):
        cat = learned["category"]
    elif rule in ("Pet", "Impostos"):
        cat = rule
    else:
        cat = PLUGGY_CATEGORY.get(x.get("category")) or rule or "Outros"
    return cat if cat in ctx.categories else "Outros"


def find_duplicate(ctx, bank, day, amounts):
    """Lançamento que não veio do Pluggy com o mesmo valor, data a até DUP_DAYS e mesmo banco (ou sem banco). Cada um casa uma vez."""
    def matches(c):
        same_bank = not c.get("bank") or fold(c["bank"]) == fold(bank)
        close = abs((dt.date.fromisoformat(str(c["date"])[:10]) - day).days) <= DUP_DAYS
        value = cents(c["amount"]) in amounts or (c.get("installment_no") == 1 and c.get("total_amount") and cents(c["total_amount"]) in amounts)
        return same_bank and close and value
    hits = [c for c in ctx.candidates if matches(c)]
    if not hits:
        return None
    best = min(hits, key=lambda c: abs((dt.date.fromisoformat(str(c["date"])[:10]) - day).days))
    ctx.candidates.remove(best)
    return best


def expense_row(x, bank, method, bill, ctx, debt=None, k=None, total=None):
    d = local_date(x["date"])
    learned = ctx.learned.get(raw_key(x["description"])) or {}
    amounts = {cents(x["amount"])} | ({cents(total)} if total else set())
    dup = find_duplicate(ctx, bank, d, amounts)
    pending = " · pendente" if method == "credit" and x.get("status") == "PENDING" else ""
    return dict(id=x["id"], date=d.isoformat(), amount=round(abs(x["amount"]), 2), merchant=learned.get("merchant") or clean_merchant(x["description"]),
                category=choose_category(x, ctx), bank=bank, method=method, bill_month=bill, debt_id=debt, installment_no=k,
                note=f"pluggy{pending} · {x['description'][:80]}", review_status="pending" if dup else None,
                possible_duplicate_of=dup["id"] if dup else None, cash_debited=0 if dup else None,
                had_split=learned.get("share") is not None)


def mark(plan, x, bank, outcome, reason=None, paired=None):
    plan.marks.append(dict(id=x["id"], outcome=outcome, reason=reason, bank=bank, amount=round(abs(x["amount"]), 2),
                           date=local_date(x["date"]).isoformat(), paired_with=paired))


def is_baseline(x, ctx, kind):
    """Já contemplado pelo import inicial? Só na primeira execução. O createdAt do Pluggy decide; o que não é gasto (entrada,
    estorno, pagamento) e tem data anterior ao import também entra aqui, porque contar de novo não teria como ser desfeito."""
    if not ctx.first_run or ctx.import_at is None:
        return False
    if parse_ts(x["createdAt"]) <= ctx.import_at:
        return True
    return kind != "expense" and local_date(x["date"]) < ctx.import_at.astimezone(TZ).date()


def pair_refunds(rows, is_refund, is_purchase, bank, label, ctx, plan):
    """Casa estornos novos com compras: mesmo valor, de 1 dia antes a 30 dias depois. Devolve os ids resolvidos aqui."""
    done = set()
    used = {v["paired_with"] for v in ctx.ledger.values() if v.get("paired_with")}
    purchases = [x for x in rows if is_purchase(x)]
    for r in sorted((x for x in rows if is_refund(x)), key=lambda x: x["date"]):
        done.add(r["id"])
        if r["id"] in ctx.ledger:
            plan.counts["já processadas"] += 1
            continue
        rd = local_date(r["date"])
        hits = [x for x in purchases if x["id"] not in used and cents(x["amount"]) == cents(r["amount"]) and -1 <= (rd - local_date(x["date"])).days <= 30]
        if not hits:
            if is_baseline(r, ctx, "refund"):
                plan.counts["base do import"] += 1
                mark(plan, r, bank, "baseline")
            else:
                plan.skipped[f"{label}: estorno/crédito sem compra correspondente"] += 1
                mark(plan, r, bank, "skipped", f"{label}: estorno sem compra correspondente")
            continue
        c = min(hits, key=lambda x: abs((rd - local_date(x["date"])).days))
        used.add(c["id"])
        if is_baseline(r, ctx, "refund"):
            plan.counts["base do import"] += 1
            mark(plan, r, bank, "baseline", paired=c["id"])
        elif c["id"] in ctx.known:
            # O gasto original já está lançado e pode estar dividido ou numa fatura paga: quem decide é o usuário (Estornos recebidos).
            plan.refunds.append(dict(id=r["id"], bank=bank, amount=round(abs(r["amount"]), 2), merchant=clean_merchant(r["description"]),
                                     posted_at=r["date"], description=r["description"][:200], paired_with=c["id"], date=rd.isoformat()))
            plan.counts["estornos a revisar"] += 1
        else:
            done.add(c["id"])
            mark(plan, r, bank, "refund_paired", paired=c["id"])
            if c["id"] not in ctx.ledger:
                mark(plan, c, bank, "refund_paired", paired=r["id"])
            plan.counts["estornos casados"] += 1
    return done


def classify_bank_row(x, bank, due_months, ctx):
    """Conta corrente: ("skip", motivo) | ("income", None) | ("payment", linha) | ("expense", linha-parcial)."""
    desc, cat = x["description"], x.get("category")
    if x["type"] == "CREDIT":
        if cat in ("Same person transfer", "Transfer - Internal") or desc.startswith("Valor adicionado"):
            return "skip", "conta: entrada de conta própria"
        if cat == "Investments":
            return "skip", "conta: resgate de investimento"
        return "income", None
    if cat == "Same person transfer":
        return "skip", "conta: transferência entre contas próprias"
    d = local_date(x["date"])
    up = desc.upper()
    if desc.startswith("Pagamento de fatura"):
        due = next((m for m in due_months if m >= d.isoformat()), None)
        cy = ctx.cycles.get(bank)
        month = due[:7] if due else (next_due_month(cy, d) if cy else None)
        return "payment", dict(card_bank=bank, paid_from=bank, bill_month=month, note="pluggy · Pagamento de fatura")
    if "BANCO INTER" in up:
        return "payment", dict(card_bank="Inter", paid_from=bank, bill_month=None, note="pluggy · boleto Banco Inter")
    if "NU PAGAMENTOS" in up:
        return "skip", "conta: boleto NU PAGAMENTOS (fatura/empréstimo)"
    if cat == "Investments":
        return "skip", "conta: aplicação em investimento"
    if cat == "Loans and financing":
        return "skip", "conta: quitação de empréstimo"
    return "expense", "pix" if x.get("operationType") == "PIX" else "debit"


def handle_seen(x, bank, kind, ctx, plan):
    """True se a transação já foi tratada: está no ledger, já existe no banco ou é da base do import inicial."""
    if x["id"] in ctx.ledger:
        plan.counts["já processadas"] += 1
        return True
    if x["id"] in ctx.known:
        plan.counts["já no banco"] += 1
        mark(plan, x, bank, "known")
        return True
    if is_baseline(x, ctx, kind):
        plan.counts["base do import"] += 1
        mark(plan, x, bank, "baseline")
        return True
    return False


def add_expense(plan, row):
    plan.expenses.append(row)
    plan.counts["possíveis duplicatas" if row["possible_duplicate_of"] else "gastos novos"] += 1
    if row["had_split"]:
        plan.counts["aviso: já foi dividido antes"] += 1


def classify_bank(account, ctx, plan):
    rows, bank = account["txs"], account["bank"]
    is_refund = lambda x: x["type"] == "CREDIT" and x["description"].lower().startswith(("estorno", "reembolso"))
    done = pair_refunds(rows, is_refund, lambda x: x["type"] == "DEBIT" and x.get("category") != "Same person transfer", bank, "conta", ctx, plan)
    due_months = sorted(b["dueDate"][:10] for b in account.get("card_bills") or [])
    for x in rows:
        if x["id"] in done:
            continue
        kind, data = classify_bank_row(x, bank, due_months, ctx)
        if handle_seen(x, bank, kind, ctx, plan):
            continue
        d = local_date(x["date"])
        a = round(abs(x["amount"]), 2)
        if kind == "skip":
            plan.skipped[data] += 1
            mark(plan, x, bank, "skipped", data)
        elif kind == "income":
            plan.incomes.append(dict(id=x["id"], bank=bank, amount=a, date=d.isoformat(), month=d.strftime("%Y-%m")))
            plan.counts["entradas"] += 1
            if cents(a) in ctx.receivable:
                plan.counts["aviso: entrada igual a um valor a receber"] += 1
        elif kind == "payment":
            dup = next((p for p in ctx.manual_payments if fold(p["card_bank"]) == fold(data["card_bank"]) and cents(p["amount"]) == cents(a)
                        and abs((dt.date.fromisoformat(str(p["date"])[:10]) - d).days) <= DUP_DAYS), None)
            if dup:
                ctx.manual_payments.remove(dup)
                plan.skipped["conta: pagamento de fatura já lançado"] += 1
                mark(plan, x, bank, "skipped", "conta: pagamento de fatura já lançado")
            else:
                plan.payments.append(dict(id=x["id"], date=d.isoformat(), amount=a, bank=bank, **data))
                plan.counts["pagamentos de fatura"] += 1
        else:
            add_expense(plan, expense_row(x, bank, data, None, ctx))


def classify_card(account, ctx, plan):
    rows, bank = account["txs"], account["bank"]
    bills = {b["id"]: b for b in account.get("bills") or []}
    cy = ctx.cycles.get(bank)

    def bill_of(x):
        bid = (x.get("creditCardMetadata") or {}).get("billId")
        if bid in bills:
            return bills[bid]["dueDate"][:7]
        return bill_month_of(cy, local_date(x["date"])) if cy else None

    done = pair_refunds(rows, lambda x: x["type"] == "CREDIT" and x.get("operationType") != "PAGAMENTO_FATURA",
                        lambda x: x["type"] == "DEBIT", bank, "cartão", ctx, plan)
    plans = {}
    for x in rows:
        md = x.get("creditCardMetadata") or {}
        n, k = md.get("totalInstallments") or 0, md.get("installmentNumber")
        if x["type"] == "DEBIT" and n > 1 and k:
            purchase = md.get("purchaseDate") or md.get("transactionDateTime") or x["date"]
            plans.setdefault(plan_id(x), dict(description=clean_merchant(x["description"]), n=n, purchase=local_date(purchase).isoformat(), rows=[]))["rows"].append(
                (k, round(abs(x["amount"]), 2), bill_of(x)))
    opened = bill_month_of(cy, ctx.today) if cy else None
    for x in rows:
        if x["id"] in done:
            continue
        if x["type"] == "CREDIT":
            if handle_seen(x, bank, "payment", ctx, plan):
                continue
            plan.skipped["cartão: pagamento recebido (já contado pela conta)"] += 1
            mark(plan, x, bank, "skipped", "cartão: pagamento recebido")
            continue
        if handle_seen(x, bank, "expense", ctx, plan):
            continue
        md = x.get("creditCardMetadata") or {}
        n, k = md.get("totalInstallments") or 0, md.get("installmentNumber")
        debt, total, debt_k = None, None, None
        if n > 1 and k:
            debt, debt_k = plan_id(x), k
            p = plans[debt]
            rs = sorted(p["rows"], key=lambda r: r[0])
            inst = collections.Counter(a for _, a, _ in rs).most_common(1)[0][0]
            if k == rs[0][0]:                  # a notificação mostra o total da compra: só a primeira parcela compara com ele
                total = round(inst * n, 2)
            if debt not in ctx.debts and debt not in plan.debts:
                k0, _, b0 = rs[0]
                plan.debts[debt] = dict(id=debt, description=p["description"], bank=bank, installment_amount=inst, installments_total=n,
                                        installments_paid=sum(1 for _, _, b in rs if b and opened and b < opened) + (k0 - 1),
                                        due_day=cy[1] if cy else None, total_amount=round(inst * n, 2), purchase_date=p["purchase"],
                                        first_bill=shift_month(b0, -(k0 - 1)) if b0 else None)
        add_expense(plan, expense_row(x, bank, "credit", bill_of(x), ctx, debt, debt_k, total))


def drop_live_pending(candidates, accounts):
    """Compra pendente importada só é candidata se o Pluggy parou de devolver o id dela: é o caso de ela voltar publicada com id novo."""
    live = {x["id"] for a in accounts for x in a["txs"]}
    return [c for c in candidates if not (str(c.get("note") or "").startswith("pluggy · pendente") and c["id"] in live)]


def classify(accounts, ctx):
    plan = Plan()
    ctx.candidates = drop_live_pending(ctx.candidates, accounts)
    card_bills = {}
    for a in accounts:
        if a["type"] == "CREDIT":
            card_bills.setdefault(a["bank"], []).extend(a.get("bills") or [])
    for a in accounts:
        if a["type"] == "CREDIT":
            classify_card(a, ctx, plan)
        else:
            classify_bank({**a, "card_bills": card_bills.get(a["bank"])}, ctx, plan)
    return plan


# ---------------------------------------------------------------- Pluggy (HTTPS, só leitura)
class PluggyError(Exception):
    pass


class Pluggy:
    def __init__(self, client_id, client_secret, opener=None):
        self.client_id, self.client_secret = client_id, client_secret
        self.key = None
        self.opener = opener or urllib.request.urlopen

    def scrub(self, text):
        for s in (self.client_secret, self.client_id, self.key):
            if s:
                text = text.replace(s, "***")
        return text

    def call(self, path, body=None):
        headers = {"Accept": "application/json", "Content-Type": "application/json", "User-Agent": "buffet-cli"}
        if self.key:
            headers["X-API-KEY"] = self.key
        req = urllib.request.Request(API + path, data=json.dumps(body).encode() if body else None, method="POST" if body else "GET", headers=headers)
        try:
            return json.load(self.opener(req, timeout=60))
        except urllib.error.HTTPError as e:
            try:
                msg = json.loads(e.read()).get("message", "")
            except Exception:
                msg = ""
            raise PluggyError(self.scrub(f"erro: Pluggy respondeu {e.code}" + (f": {msg}" if msg else ""))) from None
        except (urllib.error.URLError, TimeoutError) as e:
            raise PluggyError(self.scrub(f"erro: sem resposta do Pluggy ({e})")) from None

    def auth(self):
        self.key = self.call("/auth", {"clientId": self.client_id, "clientSecret": self.client_secret})["apiKey"]

    def item(self, item_id):
        return self.call("/items/" + urllib.parse.quote(item_id))

    def accounts(self, item_id):
        return self.call("/accounts?" + urllib.parse.urlencode({"itemId": item_id}))["results"]

    def transactions(self, account_id, since):
        out, path = [], "/v2/transactions?" + urllib.parse.urlencode({"accountId": account_id, "dateFrom": since})
        for _ in range(1000):
            r = self.call(path)
            out += r["results"]
            nxt = r.get("next")
            if not nxt:
                return out
            path = "/v2/transactions" + nxt[nxt.index("?"):]
        raise PluggyError("erro: paginação do Pluggy não terminou")

    def bills(self, account_id):
        out, page = [], 1
        while True:
            r = self.call("/bills?" + urllib.parse.urlencode({"accountId": account_id, "page": page}))
            out += r["results"]
            if page >= (r.get("totalPages") or 1):
                return out
            page += 1


def credentials():
    """(client_id, client_secret, [(item_id, banco|None)]). Erros dizem o que falta, nunca o valor."""
    id_file = os.environ.get("PLUGGY_CLIENT_ID_FILE", CLIENT_ID_FILE)
    items_file = os.environ.get("PLUGGY_ITEM_IDS_FILE", ITEM_IDS_FILE)
    secret = os.environ.get("PLUGGY_CLIENT_SECRET")
    if not secret:
        sys.exit("erro: PLUGGY_CLIENT_SECRET ausente")
    try:
        with open(id_file) as f:
            client_id = f.read().strip()
        with open(items_file) as f:
            lines = f.read().splitlines()
    except OSError:
        sys.exit("erro: arquivo de credenciais do Pluggy não encontrado")
    items = [(p[0], " ".join(p[1:]) or None) for p in (l.split() for l in lines if l.strip() and not l.startswith("#"))]
    if not client_id or not items:
        sys.exit("erro: credenciais do Pluggy vazias")
    return client_id, secret, items


def fetch_pluggy(client, items, default_bank, since, warn):
    """[{bank, type, txs, bills}], {banco: {balance, snapshot, ok}}."""
    accounts, balances = [], {}
    for item_id, label in items:
        item = client.item(item_id)
        bank = label or default_bank
        ok = item.get("status") == "UPDATED" and item.get("executionStatus") in ("SUCCESS", "PARTIAL_SUCCESS")
        if not ok:
            warn(f"aviso: item de {bank} não está atualizado no Pluggy (status {item.get('status')}/{item.get('executionStatus')}); o caixa não será alterado")
        for a in client.accounts(item_id):
            accounts.append(dict(bank=bank, type=a["type"], txs=client.transactions(a["id"], since), bills=client.bills(a["id"]) if a["type"] == "CREDIT" else []))
            if a["type"] == "BANK" and a.get("currencyCode", "BRL") == "BRL":
                b = balances.setdefault(bank, dict(balance=0.0, snapshot=item.get("lastUpdatedAt"), ok=True))
                b["balance"] = round(b["balance"] + float(a["balance"]), 2)
                b["ok"] = b["ok"] and ok
    return accounts, balances


# ---------------------------------------------------------------- banco
def ledger_exists(b):
    return bool(b.bot(f"select to_regclass('{LEDGER}')::text as t")[0]["t"])


def load_context(b, since, cfg, has_ledger):
    bot, lit = b.bot, b.lit
    tx_ids = bot("select id from public.buffet_transactions union all select id from public.buffet_card_payments")
    hist = bot("select note, merchant, category, split_share_pct, debt_id from public.buffet_transactions where note like 'pluggy%' order by date desc, created_at desc")
    at = bot("select max(created_at) as m from public.buffet_transactions where note like 'pluggy ·%'")[0]["m"]
    start = (dt.date.fromisoformat(since) - dt.timedelta(days=DUP_DAYS)).isoformat()
    cand = bot("select t.id, t.date, t.amount, t.bank, t.installment_no, t.note, d.total_amount from public.buffet_transactions t "
               "left join public.buffet_debts d on d.id = t.debt_id "
               f"where (t.note is null or t.note not like 'pluggy%' or t.note like 'pluggy · pendente%' or t.notification_id is not null) and t.date >= {lit(start)} "
               "and not exists (select 1 from public.buffet_transactions y where y.possible_duplicate_of = t.id) order by t.date desc")
    pays = bot(f"select id, date, amount, card_bank from public.buffet_card_payments where (note is null or note not like 'pluggy%') and date >= {lit(start)}")
    owed = bot("select partner_amount - coalesce(reimbursed_amount, 0) as v from public.buffet_transactions where partner_amount > coalesce(reimbursed_amount, 0)")
    ledger = {r["id"]: r for r in bot(f"select id, outcome, paired_with from {LEDGER}")} if has_ledger else {}
    cycles = {x["name"]: (int(x["credit"]["closing_day"]), int(x["credit"]["due_day"])) for x in cfg.get("banks") or []
              if (x.get("credit") or {}).get("closing_day") and (x.get("credit") or {}).get("due_day")}
    cats = bot("select categories from public.buffet_app_config")
    return Ctx(today=b.today(), categories=(cats[0]["categories"] if cats else None) or list(b.CATEGORIES), known={r["id"] for r in tx_ids}, ledger=ledger,
               import_at=parse_ts(at) if at else None, candidates=cand, manual_payments=pays, learned=learn_rows(hist),
               debts={r["id"] for r in bot("select id from public.buffet_debts")}, receivable=[cents(r["v"]) for r in owed], cycles=cycles)


def sql_num(v):
    return "null" if v is None else f"{float(v):.2f}"


def ledger_values(b, rows):
    lit = b.lit
    return ", ".join(f"({lit(r['id'])}, {lit(r['outcome'])}, {lit(r.get('reason'))}, {lit(r.get('bank'))}, {sql_num(r.get('amount'))}, {lit(r.get('date'))}, {lit(r.get('paired_with'))})" for r in rows)


LEDGER_CTE = "l as (insert into " + LEDGER + " (id, outcome, reason, bank, amount, date, paired_with) select v.id, v.outcome, v.reason, v.bank, v.amount::numeric, v.date::date, v.paired_with from (values {vals}) as v (id, outcome, reason, bank, amount, date, paired_with) on conflict (id) do nothing returning id)"


def write_marks(b, marks):
    for i in range(0, len(marks), BATCH):
        b.bot("with " + LEDGER_CTE.format(vals=ledger_values(b, marks[i:i + BATCH])) + " select count(*) as n from l")


def write_debts(b, debts):
    lit = b.lit
    if not debts:
        return
    vals = ", ".join(f"({lit(d['id'])}, {lit(d['description'])}, {lit(d['bank'])}, {lit(d['bank'])}, 'installments', {sql_num(d['installment_amount'])}, {d['installments_paid']}, "
                     f"{d['installments_total']}, {d['due_day'] if d['due_day'] else 'null'}, {sql_num(d['total_amount'])}, {lit(d['purchase_date'])}, {lit(d['first_bill'])}, 'bot')" for d in debts)
    b.bot("insert into public.buffet_debts (id, description, bank, card, kind, installment_amount, installments_paid, installments_total, due_day, total_amount, "
          f"purchase_date, first_bill, source) select v.id, v.d, v.b, v.c, v.k, v.ia::numeric, v.ip::int, v.it::int, v.dd::int, v.ta::numeric, v.pd::date, v.fb, v.s from (values {vals}) "
          "as v (id, d, b, c, k, ia, ip, it, dd, ta, pd, fb, s) on conflict (id) do nothing")


def write_expenses(b, rows):
    lit = b.lit
    for i in range(0, len(rows), BATCH):
        chunk = rows[i:i + BATCH]
        marks = [dict(id=r["id"], outcome="possible_duplicate" if r["possible_duplicate_of"] else "expense", bank=r["bank"], amount=r["amount"], date=r["date"]) for r in chunk]
        vals = ", ".join(f"({lit(r['id'])}, {lit(r['date'])}, {sql_num(r['amount'])}, {lit(r['merchant'])}, {lit(r['category'])}, {lit(r['bank'])}, {lit(r['method'])}, {lit(r['bill_month'])}, "
                         f"{lit(r['debt_id'])}, {r['installment_no'] or 'null'}, {lit(r['note'])}, {lit(r['review_status'])}, {lit(r['possible_duplicate_of'])}, {sql_num(r['cash_debited'])})" for r in chunk)
        b.bot("with " + LEDGER_CTE.format(vals=ledger_values(b, marks)) + ", t as (insert into public.buffet_transactions (id, date, amount, merchant, category, bank, method, bill_month, debt_id, "
              "installment_no, note, source, review_status, possible_duplicate_of, cash_debited) select v.id, v.d::date, v.a::numeric, v.m, v.c, v.b, v.me, v.bm, v.db, v.k::int, v.n, 'bot', v.rs, v.dup, v.cd::numeric "
              f"from (values {vals}) as v (id, d, a, m, c, b, me, bm, db, k, n, rs, dup, cd) join l on l.id = v.id on conflict do nothing returning id) select count(*) as n from t")


def write_payment(b, r):
    lit = b.lit
    mk = dict(id=r["id"], outcome="card_payment", bank=r["bank"], amount=r["amount"], date=r["date"])
    insert = ("p as (insert into public.buffet_card_payments (id, date, amount, card_bank, paid_from, bill_month, note, source) select l.id, "
              f"{lit(r['date'])}::date, {sql_num(r['amount'])}, {lit(r['card_bank'])}, {lit(r['paid_from'])}, {lit(r['bill_month'])}, {lit(r['note'])}, 'bot' from l on conflict (id) do nothing returning *)")
    ctes = ["with " + LEDGER_CTE.format(vals=ledger_values(b, [mk])), insert]
    if r["bill_month"]:                    # as mesmas duas atualizações do buffet pay-bill; o caixa vem do saldo do Pluggy
        ctes += ["b as (update public.buffet_debts d set installments_paid = d.installments_total from p where d.kind = 'bill' and lower(d.card) = lower(p.card_bank) and d.first_bill = p.bill_month returning d.id)",
                 "i as (update public.buffet_debts d set installments_paid = greatest(d.installments_paid, (select count(*) from public.buffet_transactions x where x.debt_id = d.id and x.bill_month <= p.bill_month)) "
                 "from p where d.kind = 'installments' and lower(d.card) = lower(p.card_bank) returning d.id)"]
    b.bot(", ".join(ctes) + " select count(*) as n from p")


def write_incomes(b, rows):
    for i in range(0, len(rows), BATCH):
        marks = [dict(id=r["id"], outcome="income", bank=r["bank"], amount=r["amount"], date=r["date"]) for r in rows[i:i + BATCH]]
        vals = ", ".join(f"({b.lit(r['id'])}, {b.lit(r['month'])}, {sql_num(r['amount'])})" for r in rows[i:i + BATCH])
        b.bot("with " + LEDGER_CTE.format(vals=ledger_values(b, marks)) + f", n as (select v.m, sum(v.a::numeric) as a from (values {vals}) as v (id, m, a) join l on l.id = v.id group by v.m) "
              "insert into public.buffet_incomes (month, amount, source) select n.m, n.a, 'bot' from n "
              "on conflict (user_id, month) do update set amount = public.buffet_incomes.amount + excluded.amount, updated_at = now()")


INBOX_BANK = {"nubank": "nubank", "inter": "inter", "neon": "neon"}


def write_refunds(b, rows):
    lit = b.lit
    for r in rows:
        mk = dict(id=r["id"], outcome="refund_review", bank=r["bank"], amount=r["amount"], date=r["date"], paired_with=r["paired_with"])
        payload = json.dumps({"origem": "pluggy", "id": r["id"]})
        b.bot("with " + LEDGER_CTE.format(vals=ledger_values(b, [mk])) + ", i as (insert into public.buffet_notification_inbox (id, payload, payload_hash, app, title, body, posted_at, bank, kind, amount, merchant, status, reason) "
              f"select l.id, {lit(payload)}::jsonb, {lit('pluggy:' + r['id'])}, 'pluggy', 'Estorno (Pluggy)', {lit(r['description'])}, {lit(r['posted_at'])}::timestamptz, "
              f"{lit(INBOX_BANK.get(fold(r['bank']), 'desconhecido'))}, 'refund', {sql_num(r['amount'])}, {lit(r['merchant'])}, 'refund', 'estorno de gasto já lançado' from l on conflict do nothing returning id) select count(*) as n from i")


def after_snapshot(lit, cash):
    """Filtro do que saiu depois da última leitura do banco: a notificação ou o lançamento manual já descontou e o saldo do Pluggy ainda não sabe."""
    return (f"t.created_at > {lit(cash['snapshot'])}::timestamptz and t.method in ('debit', 'pix') and lower(t.bank) = lower({lit(cash['bank'])}) "
            f"and (t.note is null or t.note not like 'pluggy%') and t.date >= {lit(cash['day'])}")


def cash_preview(b, cfg, balances, warn):
    """O novo caixa (saldo do Pluggy menos o que saiu depois da foto dele), ou None se o caixa não deve mudar."""
    bank = cfg.get("cash_balance_bank")
    if not bank:
        warn("aviso: sem conta do saldo (cash_balance_bank); o caixa não será alterado")
        return None
    info = next((v for k, v in balances.items() if fold(k) == fold(bank)), None)
    if info is None:
        warn(f"aviso: nenhuma conta do Pluggy para {bank}; o caixa não será alterado")
        return None
    if not info["ok"] or not info["snapshot"]:
        return None
    ts = parse_ts(info["snapshot"])
    cash = dict(balance=info["balance"], snapshot=ts.isoformat(), day=ts.astimezone(TZ).date().isoformat(), bank=bank)
    after = float(b.bot(f"select coalesce(sum(coalesce(t.cash_debited, t.amount)), 0) as v from public.buffet_transactions t where {after_snapshot(b.lit, cash)}")[0]["v"])
    cash["value"] = round(info["balance"] - after, 2)
    return cash


def write_cash(b, cash):
    lit = b.lit
    # Valor absoluto, recalculado no próprio comando. O que veio antes da foto já está no saldo: cash_debited zera para o descarte não devolver dinheiro que o saldo já contou.
    b.bot(f"with a as (select coalesce(sum(coalesce(t.cash_debited, t.amount)), 0) as v from public.buffet_transactions t where {after_snapshot(lit, cash)}), "
          f"z as (update public.buffet_transactions t set cash_debited = 0 where t.review_status = 'pending' and t.cash_debited > 0 and t.created_at <= {lit(cash['snapshot'])}::timestamptz returning t.id) "
          f"update public.buffet_app_config c set cash_balance = {cash['balance']:.2f} - a.v, updated_at = now() from a")


def apply_plan(b, plan, cash):
    write_debts(b, list(plan.debts.values()))
    write_expenses(b, plan.expenses)
    for p in plan.payments:
        write_payment(b, p)
    write_incomes(b, plan.incomes)
    write_refunds(b, plan.refunds)
    write_marks(b, plan.marks)
    if cash:
        write_cash(b, cash)


# ---------------------------------------------------------------- comando
def report(b, plan, total, cash, current, dry, verbose):
    print("pluggy-sync" + (" (dry-run: nada foi gravado)" if dry else ""))
    print(f"lidas: {total}")
    for k in ("já processadas", "já no banco", "base do import", "gastos novos", "possíveis duplicatas", "pagamentos de fatura", "entradas", "estornos casados", "estornos a revisar"):
        if plan.counts[k]:
            print(f"  {k}: {plan.counts[k]}")
    if plan.debts:
        print(f"  planos de parcelas novos: {len(plan.debts)}")
    if plan.skipped:
        print(f"  ignoradas: {sum(plan.skipped.values())}")
        for k, v in sorted(plan.skipped.items()):
            print(f"    {k}: {v}")
    for k in sorted(plan.counts):
        if k.startswith("aviso:"):
            print(f"  {k}: {plan.counts[k]}")
    if not cash:
        print("  caixa: não alterado")
    elif current is not None and abs(float(current) - cash["value"]) < 0.005:
        print("  caixa: sem mudança")
    else:
        print(f"  caixa: {b.brl(float(current)) if current is not None else '–'} → {b.brl(cash['value'])}")
    if verbose:
        for r in plan.expenses:
            print(f"  {r['date']}  {r['amount']:>10.2f}  {r['method']:<6}  {r['category']:<20}  {r['merchant']}" + ("  (possível duplicata)" if r["possible_duplicate_of"] else ""))


def main(args, b):
    pos, o = b.opts(args, flags=("days",), bools=("dry-run", "verbose"))
    if pos:
        sys.exit("uso: buffet pluggy-sync [--dry-run] [--days 45] [--verbose]")
    dry = bool(o.get("dry-run"))
    days = int(o.get("days", LOOKBACK_DAYS))
    if not 1 <= days <= 365:
        sys.exit("erro: --days entre 1 e 365")
    if dry:
        os.environ["BUFFET_ROLLBACK"] = "1"   # defesa extra: mesmo um comando de escrita acabaria em rollback
    has_ledger = ledger_exists(b)
    if not has_ledger and not dry:
        sys.exit(NO_LEDGER)
    client_id, secret, items = credentials()
    since = (b.today() - dt.timedelta(days=days)).isoformat()
    cfg = b.config()
    warn = lambda m: print(m, file=sys.stderr)
    client = Pluggy(client_id, secret)
    try:
        client.auth()
        accounts, balances = fetch_pluggy(client, items, cfg.get("cash_balance_bank") or "Nubank", since, warn)
    except PluggyError as e:
        sys.exit(str(e))
    plan = classify(accounts, load_context(b, since, cfg, has_ledger))
    cash = cash_preview(b, cfg, balances, warn)
    if not dry:
        apply_plan(b, plan, cash)
    report(b, plan, sum(len(a["txs"]) for a in accounts), cash, cfg.get("cash_balance"), dry, bool(o.get("verbose")))
    if plan.counts["possíveis duplicatas"] or plan.counts["estornos a revisar"]:
        print("revisar: buffet pending")
