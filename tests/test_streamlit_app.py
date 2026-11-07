"""
Streamlit AppTest Suite.
Verifies the Streamlit dashboard and navigation render without runtime errors.
"""

import unittest
import os
os.environ["USE_SQLITE"] = "true"
from streamlit.testing.v1 import AppTest

class TestStreamlitApp(unittest.TestCase):
    def test_app_loads_successfully(self):
        at = AppTest.from_file("app.py", default_timeout=60)
        at.run()
        # Verify no unhandled exception
        self.assertFalse(at.exception)
        # Verify title or header exists
        self.assertTrue(len(at.title) > 0 or len(at.sidebar) > 0)

    def test_contacts_page_renders(self):
        at = AppTest.from_file("pages/6_contacts.py", default_timeout=60)
        at.run()
        self.assertFalse(at.exception)
        self.assertTrue(len(at.title) > 0)

    def test_schedules_page_renders(self):
        at = AppTest.from_file("pages/2_schedules.py", default_timeout=60)
        at.run()
        self.assertFalse(at.exception)
        self.assertTrue(len(at.title) > 0)

if __name__ == "__main__":
    unittest.main()

