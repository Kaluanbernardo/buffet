"""Testes da regra do pluggy-sync. Só dados fictícios. Rodar: python3 -B -m unittest discover -s scripts/tests"""
import datetime as dt, io, json, os, pathlib, sys, tempfile, unittest, urllib.error
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
import buffet_pluggy as P

CATS = ["Alimentação", "Transporte", "Mercado", "Pet", "Impostos", "Moradia", "Outros"]
OLD = "2026-01-01T12:00:00.000Z"
NOW = "2026-06-20T12:00:00.000Z"


def ctx(**k):
    base = dict(today=dt.date(2026, 6, 20), categories=CATS, known=set(), ledger={"antigo": {"outcome": "skipped", "paired_with": None}},
                cycles={"Banco A": (11, 15)})
    base.update(k)
    return P.Ctx(**base)


def tx(i, amount, desc="LOJA EXEMPLO", typ="DEBIT", date="2026-06-10T15:00:00.000Z", **k):
    return dict(id=i, amount=amount, description=desc, type=typ, date=date, createdAt=NOW, status="POSTED", category=None, operationType=None, creditCardMetadata=None, **k)


def bank(*rows):
    return dict(bank="Banco A", type="BANK", txs=list(rows), bills=[])


def card(*rows, bills=()):
    return dict(bank="Banco A", type="CREDIT", txs=list(rows), bills=list(bills))


def inst(i, k, n, amount=30.0, desc="LOJA PARCELADA", date="2026-06-10T15:00:00.000Z"):
    x = tx(i, amount, f"{desc} {k}/{n}", date=date)
    x["creditCardMetadata"] = {"totalInstallments": n, "installmentNumber": k, "purchaseDate": "2026-06-10T15:00:00.000Z", "cardNumber": "0000"}
    return x


def only(plan, field="expenses"):
    rows = getattr(plan, field)
    assert len(rows) == 1, rows
    return rows[0]


class ContaCorrente(unittest.TestCase):
    def test_pix_e_debito_viram_gasto(self):
        pix = tx("p", -50.0, "Transferência enviada pelo Pix|PADARIA EXEMPLO")
        pix["operationType"] = "PIX"
        plan = P.classify([bank(pix, tx("d", -10.0, "Compra no débito|FEIRA TESTE"))], ctx())
        rows = {r["id"]: r for r in plan.expenses}
        self.assertEqual(rows["p"]["method"], "pix")
        self.assertEqual(rows["p"]["merchant"], "Padaria Exemplo")
        self.assertEqual(rows["p"]["note"], "pluggy · Transferência enviada pelo Pix|PADARIA EXEMPLO")
        self.assertEqual(rows["p"]["amount"], 50.0)
        self.assertEqual(rows["d"]["method"], "debit")
        self.assertIsNone(rows["d"]["bill_month"])
        self.assertIsNone(rows["d"]["review_status"])

    def test_transferencia_propria_nao_vira_gasto(self):
        out = tx("a", -100.0, "Transferência")
        out["category"] = "Same person transfer"
        into = tx("b", 100.0, "Transferência", typ="CREDIT")
        into["category"] = "Same person transfer"
        added = tx("c", 5.0, "Valor adicionado na conta", typ="CREDIT")
        plan = P.classify([bank(out, into, added)], ctx())
        self.assertEqual(plan.expenses, [])
        self.assertEqual(plan.incomes, [])
        self.assertEqual(plan.skipped["conta: transferência entre contas próprias"], 1)
        self.assertEqual(plan.skipped["conta: entrada de conta própria"], 2)

    def test_investimento_e_emprestimo_nao_viram_gasto(self):
        rows = [tx(str(i), a, typ=t) for i, (a, t) in enumerate([(-10, "DEBIT"), (10, "CREDIT")])]
        for r in rows:
            r["category"] = "Investments"
        loan = tx("l", -9.0)
        loan["category"] = "Loans and financing"
        plan = P.classify([bank(*rows, loan, tx("n", -3.0, "BOLETO NU PAGAMENTOS"))], ctx())
        self.assertEqual((plan.expenses, plan.incomes), ([], []))
        self.assertEqual(sum(plan.skipped.values()), 4)

    def test_entrada_vira_renda_do_mes(self):
        plan = P.classify([bank(tx("s", 1000.0, "Transferência recebida", typ="CREDIT"))], ctx())
        r = only(plan, "incomes")
        self.assertEqual((r["month"], r["amount"]), ("2026-06", 1000.0))

    def test_pagamento_de_fatura_usa_o_vencimento_do_pluggy(self):
        bills = [dict(id="f1", dueDate="2026-06-15T00:00:00.000Z"), dict(id="f2", dueDate="2026-07-15T00:00:00.000Z")]
        plan = P.classify([bank(tx("x", -500.0, "Pagamento de fatura")), card(bills=bills)], ctx())
        p = only(plan, "payments")
        self.assertEqual((p["card_bank"], p["paid_from"], p["bill_month"]), ("Banco A", "Banco A", "2026-06"))
        self.assertEqual(plan.expenses, [])

    def test_pagamento_de_fatura_sem_lista_usa_o_ciclo(self):
        p = only(P.classify([bank(tx("x", -500.0, "Pagamento de fatura", date="2026-06-16T15:00:00.000Z"))], ctx()), "payments")
        self.assertEqual(p["bill_month"], "2026-07")

    def test_pagamento_ja_lancado_a_mao_nao_repete(self):
        c = ctx(manual_payments=[dict(id="m", date="2026-06-11", amount=500, card_bank="Banco A")])
        plan = P.classify([bank(tx("x", -500.0, "Pagamento de fatura"))], c)
        self.assertEqual(plan.payments, [])
        self.assertEqual(plan.skipped["conta: pagamento de fatura já lançado"], 1)

    def test_boleto_de_outro_banco_e_pagamento_desse_cartao(self):
        p = only(P.classify([bank(tx("x", -80.0, "BOLETO BANCO INTER SA"))], ctx()), "payments")
        self.assertEqual((p["card_bank"], p["bill_month"]), ("Inter", None))


class Cartao(unittest.TestCase):
    def test_fatura_pelo_ciclo(self):
        before = tx("a", 10.0, date="2026-06-10T15:00:00.000Z")
        closing = tx("b", 11.0, date="2026-06-11T15:00:00.000Z")
        rows = {r["id"]: r for r in P.classify([card(before, closing)], ctx()).expenses}
        self.assertEqual(rows["a"]["bill_month"], "2026-06")
        self.assertEqual(rows["b"]["bill_month"], "2026-07")
        self.assertEqual(rows["a"]["method"], "credit")

    def test_data_em_utc_vale_o_dia_de_brasilia(self):
        r = only(P.classify([card(tx("a", 10.0, date="2026-06-11T02:00:00.000Z"))], ctx()))
        self.assertEqual((r["date"], r["bill_month"]), ("2026-06-10", "2026-06"))

    def test_fatura_informada_pelo_pluggy_vence_o_ciclo(self):
        x = tx("a", 10.0, date="2026-06-10T15:00:00.000Z")
        x["creditCardMetadata"] = {"billId": "f9"}
        r = only(P.classify([card(x, bills=[dict(id="f9", dueDate="2026-08-15T00:00:00.000Z")])], ctx()))
        self.assertEqual(r["bill_month"], "2026-08")

    def test_nota_marca_pendente(self):
        x = tx("a", 10.0, "Loja")
        x["status"] = "PENDING"
        self.assertEqual(only(P.classify([card(x)], ctx()))["note"], "pluggy · pendente · Loja")

    def test_pagamento_recebido_no_cartao_e_ignorado(self):
        x = tx("a", -500.0, "Pagamento recebido", typ="CREDIT")
        x["operationType"] = "PAGAMENTO_FATURA"
        plan = P.classify([card(x)], ctx())
        self.assertEqual(plan.skipped["cartão: pagamento recebido (já contado pela conta)"], 1)

    def test_parcelado_cria_plano_uma_vez(self):
        plan = P.classify([card(inst("k1", 1, 3), inst("k2", 2, 3, date="2026-07-10T15:00:00.000Z"), inst("k3", 3, 3, date="2026-08-10T15:00:00.000Z"))], ctx())
        d = only_debt(plan)
        self.assertEqual((d["installments_total"], d["installment_amount"], d["total_amount"], d["first_bill"], d["due_day"]), (3, 30.0, 90.0, "2026-06", 15))
        self.assertTrue(d["id"].startswith("pluggy-plan-"))
        self.assertEqual([r["installment_no"] for r in plan.expenses], [1, 2, 3])
        self.assertEqual({r["debt_id"] for r in plan.expenses}, {d["id"]})
        self.assertEqual(d["description"], "Loja Parcelada")

    def test_parcela_nova_de_plano_existente_nao_recria_plano(self):
        x = inst("k2", 2, 3)
        plan = P.classify([card(x)], ctx(debts={P.plan_id(x)}))
        self.assertEqual(plan.debts, {})
        self.assertEqual(only(plan)["installment_no"], 2)


def only_debt(plan):
    assert len(plan.debts) == 1, plan.debts
    return next(iter(plan.debts.values()))


class Estornos(unittest.TestCase):
    def test_compra_e_estorno_novos_nao_viram_nada(self):
        refund = tx("r", -40.0, "Estorno de compra", typ="CREDIT", date="2026-06-12T15:00:00.000Z")
        plan = P.classify([card(tx("c", 40.0), refund)], ctx())
        self.assertEqual((plan.expenses, plan.refunds), ([], []))
        self.assertEqual(plan.counts["estornos casados"], 1)
        self.assertEqual({m["id"] for m in plan.marks}, {"c", "r"})

    def test_estorno_na_conta(self):
        refund = tx("r", 40.0, "Estorno Pix", typ="CREDIT", date="2026-06-12T15:00:00.000Z")
        plan = P.classify([bank(tx("c", -40.0), refund)], ctx())
        self.assertEqual((plan.expenses, plan.incomes), ([], []))

    def test_estorno_de_gasto_ja_lancado_vai_para_revisao(self):
        refund = tx("r", -40.0, "Estorno", typ="CREDIT", date="2026-06-12T15:00:00.000Z")
        plan = P.classify([card(tx("c", 40.0), refund)], ctx(known={"c"}))
        r = only(plan, "refunds")
        self.assertEqual((r["id"], r["paired_with"]), ("r", "c"))
        self.assertEqual(plan.expenses, [])

    def test_uma_compra_casa_um_estorno_so(self):
        ledger = {"r0": {"outcome": "refund_review", "paired_with": "c"}}
        refund = tx("r", -40.0, "Estorno", typ="CREDIT", date="2026-06-12T15:00:00.000Z")
        plan = P.classify([card(tx("c", 40.0), refund)], ctx(known={"c"}, ledger=ledger))
        self.assertEqual(plan.refunds, [])
        self.assertEqual(plan.skipped["cartão: estorno/crédito sem compra correspondente"], 1)

    def test_estorno_sem_compra_e_ignorado(self):
        plan = P.classify([card(tx("r", -40.0, "Estorno", typ="CREDIT"))], ctx())
        self.assertEqual(plan.skipped["cartão: estorno/crédito sem compra correspondente"], 1)

    def test_fora_da_janela_de_30_dias_nao_casa(self):
        refund = tx("r", -40.0, "Estorno", typ="CREDIT", date="2026-07-20T15:00:00.000Z")
        plan = P.classify([card(tx("c", 40.0), refund)], ctx())
        self.assertEqual(len(plan.expenses), 1)


class Idempotencia(unittest.TestCase):
    def test_id_no_banco_nao_reimporta(self):
        plan = P.classify([bank(tx("a", -10.0))], ctx(known={"a"}))
        self.assertEqual(plan.expenses, [])
        self.assertEqual(plan.counts["já no banco"], 1)

    def test_id_no_ledger_nao_volta_mesmo_apagado(self):
        plan = P.classify([bank(tx("a", -10.0))], ctx(ledger={"a": {"outcome": "possible_duplicate", "paired_with": None}}))
        self.assertEqual((plan.expenses, plan.marks), ([], []))

    def test_entrada_no_ledger_nao_soma_de_novo(self):
        plan = P.classify([bank(tx("a", 10.0, "Salário", typ="CREDIT"))], ctx(ledger={"a": {"outcome": "income", "paired_with": None}}))
        self.assertEqual(plan.incomes, [])


class BaseInicial(unittest.TestCase):
    AT = dt.datetime(2026, 6, 15, 12, tzinfo=dt.timezone.utc)

    def first(self, **k):
        return ctx(ledger={}, import_at=self.AT, **k)

    def test_criada_antes_do_import_nao_e_nova(self):
        x = tx("a", 10.0, "Salário", typ="CREDIT")
        x["createdAt"] = OLD
        plan = P.classify([bank(x)], self.first())
        self.assertEqual(plan.incomes, [])
        self.assertEqual(plan.marks[0]["outcome"], "baseline")

    def test_gasto_atrasado_criado_depois_do_import_entra(self):
        self.assertEqual(len(P.classify([bank(tx("a", -10.0))], self.first()).expenses), 1)

    def test_entrada_antiga_nunca_soma_na_primeira_execucao(self):
        plan = P.classify([bank(tx("a", 10.0, "Salário", typ="CREDIT"))], self.first())
        self.assertEqual(plan.incomes, [])

    def test_depois_da_primeira_execucao_a_base_nao_vale(self):
        x = tx("a", -10.0)
        x["createdAt"] = OLD
        self.assertEqual(len(P.classify([bank(x)], ctx(import_at=self.AT)).expenses), 1)


class Duplicatas(unittest.TestCase):
    def cand(self, **k):
        return dict(id="m", date="2026-06-10", amount=25, bank="Banco A", installment_no=None, total_amount=None) | k

    def run_one(self, *cands, **k):
        return P.classify([card(tx("a", 25.0, **k))], ctx(candidates=list(cands))).expenses

    def test_mesmo_valor_data_e_banco_vira_pendente(self):
        r = self.run_one(self.cand(date="2026-06-13"))[0]
        self.assertEqual((r["review_status"], r["possible_duplicate_of"], r["cash_debited"]), ("pending", "m", 0))

    def test_fora_da_tolerancia_e_gasto_normal(self):
        r = self.run_one(self.cand(date="2026-06-14"))[0]
        self.assertIsNone(r["review_status"])

    def test_outro_banco_nao_e_duplicata(self):
        self.assertIsNone(self.run_one(self.cand(bank="Banco B"))[0]["possible_duplicate_of"])

    def test_outro_valor_nao_e_duplicata(self):
        self.assertIsNone(self.run_one(self.cand(amount=26))[0]["possible_duplicate_of"])

    def test_lancamento_sem_banco_casa(self):
        self.assertEqual(self.run_one(self.cand(bank=None))[0]["possible_duplicate_of"], "m")

    def test_cada_lancamento_casa_uma_vez(self):
        plan = P.classify([card(tx("a", 25.0), tx("b", 25.0))], ctx(candidates=[self.cand()]))
        self.assertEqual(sorted(str(r["possible_duplicate_of"]) for r in plan.expenses), ["None", "m"])

    def test_prefere_a_data_mais_proxima(self):
        r = self.run_one(self.cand(id="longe", date="2026-06-13"), self.cand(id="perto", date="2026-06-10"))[0]
        self.assertEqual(r["possible_duplicate_of"], "perto")

    def test_notificacao_com_total_casa_a_primeira_parcela(self):
        plan = P.classify([card(inst("k1", 1, 3), inst("k2", 2, 3, date="2026-07-10T15:00:00.000Z"))], ctx(candidates=[self.cand(amount=90)]))
        rows = {r["id"]: r for r in plan.expenses}
        self.assertEqual(rows["k1"]["possible_duplicate_of"], "m")
        self.assertIsNone(rows["k2"]["possible_duplicate_of"])


class PendenteComIdNovo(unittest.TestCase):
    PENDENTE = dict(id="velho", date="2026-06-10", amount=25, bank="Banco A", installment_no=None, total_amount=None, note="pluggy · pendente · Loja")

    def test_pendente_que_sumiu_marca_a_nova_como_duplicata(self):
        r = only(P.classify([card(tx("novo", 25.0))], ctx(candidates=[dict(self.PENDENTE)])))
        self.assertEqual(r["possible_duplicate_of"], "velho")

    def test_pendente_ainda_devolvido_nao_e_candidata(self):
        plan = P.classify([card(tx("velho", 25.0), tx("outra", 25.0))], ctx(known={"velho"}, candidates=[dict(self.PENDENTE)]))
        self.assertIsNone(only(plan)["possible_duplicate_of"])


class Categoria(unittest.TestCase):
    def test_regra_por_palavra(self):
        self.assertEqual(only(P.classify([card(tx("a", 1.0, "UBER TRIP"))], ctx()))["category"], "Transporte")

    def test_categoria_do_pluggy(self):
        x = tx("a", 1.0, "XYZ")
        x["category"] = "Groceries"
        self.assertEqual(only(P.classify([card(x)], ctx()))["category"], "Mercado")

    def test_pet_e_impostos_vencem_o_pluggy(self):
        x = tx("a", 1.0, "PETZ LOJA")
        x["category"] = "Groceries"
        self.assertEqual(only(P.classify([card(x)], ctx()))["category"], "Pet")

    def test_sem_pista_vai_para_outros(self):
        self.assertEqual(only(P.classify([card(tx("a", 1.0, "XYZ"))], ctx()))["category"], "Outros")

    def test_categoria_fora_da_lista_vira_outros(self):
        self.assertEqual(only(P.classify([card(tx("a", 1.0, "CINEMA TESTE"))], ctx()))["category"], "Outros")

    def test_aprende_nome_e_categoria(self):
        learned = P.learn_rows([dict(note="pluggy · FORNECEDOR XPTO", merchant="Aluguel", category="Moradia", split_share_pct=None, debt_id=None)])
        r = only(P.classify([card(tx("a", 1.0, "FORNECEDOR XPTO"))], ctx(learned=learned)))
        self.assertEqual((r["merchant"], r["category"]), ("Aluguel", "Moradia"))

    def test_renome_pontual_nao_vira_regra(self):
        rows = [dict(note="pluggy · Corrida", merchant="Corrida da festa", category="Transporte", split_share_pct=None, debt_id=None)] + \
               [dict(note="pluggy · Corrida", merchant="Corrida", category="Transporte", split_share_pct=None, debt_id=None)] * 3
        self.assertEqual(P.learn_rows(rows)[P.raw_key("Corrida")]["merchant"], "Corrida")

    def test_dividido_antes_so_avisa(self):
        learned = P.learn_rows([dict(note="pluggy · Faxina Teste", merchant="Faxina", category="Moradia", split_share_pct=50, debt_id=None)])
        plan = P.classify([card(tx("a", 1.0, "Faxina Teste"))], ctx(learned=learned))
        self.assertEqual(plan.counts["aviso: já foi dividido antes"], 1)
        self.assertNotIn("split_share_pct", only(plan))

    def test_entrada_igual_a_receber_so_avisa(self):
        plan = P.classify([bank(tx("a", 345.0, "Pix recebido", typ="CREDIT"))], ctx(receivable=[34500]))
        self.assertEqual(plan.counts["aviso: entrada igual a um valor a receber"], 1)
        self.assertEqual(len(plan.incomes), 1)


class Segredos(unittest.TestCase):
    def client(self, opener):
        c = P.Pluggy("id-falso", "segredo-falso", opener=opener)
        c.key = "chave-falsa"
        return c

    def test_erro_http_nao_vaza(self):
        def opener(req, timeout=None):
            raise urllib.error.HTTPError(req.full_url, 401, "x", {}, io.BytesIO(json.dumps({"message": "ruim segredo-falso id-falso chave-falsa"}).encode()))
        with self.assertRaises(P.PluggyError) as e:
            self.client(opener).call("/items/x")
        for s in ("segredo-falso", "id-falso", "chave-falsa"):
            self.assertNotIn(s, str(e.exception))

    def test_erro_de_rede_nao_vaza(self):
        def opener(req, timeout=None):
            raise urllib.error.URLError("falhou com segredo-falso")
        with self.assertRaises(P.PluggyError) as e:
            self.client(opener).call("/items/x")
        self.assertNotIn("segredo-falso", str(e.exception))

    def test_credencial_ausente_nao_mostra_valor(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.dict(os.environ, {"PLUGGY_CLIENT_SECRET": "segredo-falso", "PLUGGY_CLIENT_ID_FILE": d + "/nao-existe"}):
            with self.assertRaises(SystemExit) as e:
                P.credentials()
        self.assertNotIn("segredo-falso", str(e.exception.code))

    def test_arquivo_de_itens_aceita_banco_opcional(self):
        with tempfile.TemporaryDirectory() as d:
            pathlib.Path(d, "i").write_text("item-1\n# comentário\n\nitem-2 Banco B\n")
            pathlib.Path(d, "c").write_text("cliente\n")
            with mock.patch.dict(os.environ, {"PLUGGY_CLIENT_SECRET": "s", "PLUGGY_CLIENT_ID_FILE": d + "/c", "PLUGGY_ITEM_IDS_FILE": d + "/i"}):
                self.assertEqual(P.credentials()[2], [("item-1", None), ("item-2", "Banco B")])

    def test_paginacao_segue_o_cursor(self):
        pages = [{"results": [1], "next": "?accountId=a&after=c1"}, {"results": [2], "next": None}]
        seen = []

        def opener(req, timeout=None):
            seen.append(req.full_url)
            return io.BytesIO(json.dumps(pages[len(seen) - 1]).encode())
        self.assertEqual(self.client(opener).transactions("a", "2026-06-01"), [1, 2])
        self.assertIn("/v2/transactions?accountId=a&dateFrom=2026-06-01", seen[0])
        self.assertTrue(seen[1].endswith("/v2/transactions?accountId=a&after=c1"))


if __name__ == "__main__":
    unittest.main()
