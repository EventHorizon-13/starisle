import unittest
from unittest.mock import patch
import app


class StarAliasRegressionChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.astro = app.AstronomyData()

    @classmethod
    def tearDownClass(cls):
        cls.astro.eph.close()
        for kernel in cls.astro.satellite_eph.values():
            kernel.close()

    def test_chinese_names_component_aliases_and_existing_search(self):
        cases = {'南门二A':{71683},'南门二Ａ':{71683},'南门二 a':{71683},'南门二B':{71681},'南门二':{71683,71681,70890},'南门二甲':{71683},'南门二乙':{71681},'Alpha Centauri A':{71683},'Rigil Kentaurus':{71683},'Toliman':{71681},'比邻星':{70890},'巴纳德星':{87937},'天社一':{39953},'海石一':{41037},'弧矢七':{33579},'孔雀十一':{100751},'南船五':{45238},'天狼星A':{32349},'南河三A':{37279},'天狼星':{32349},'织女一':{91262},'北极星':{11767},'河鼓二':{97649},'HIP 71683':{71683},'HD 128620':{71683},'天狼星B':set(),'南河三B':set()}
        with patch.object(app, "get_astro", return_value=self.astro):
            for query, expected in cases.items():
                with self.subTest(query=query):
                    results = app.calculate_search(query, 0, 0, "2026-10-09T12:00:00Z")["results"]
                    self.assertEqual({item.get("hip") for item in results}, expected)
