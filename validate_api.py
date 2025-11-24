#!/usr/bin/env python3
"""
Fireenrich API Validation Script
Tests all core API endpoints to verify functionality
"""

import json
import os
import sys
import time

# Install requests and python-dotenv if not available
try:
    import requests
    from dotenv import load_dotenv
except ImportError as e:
    print("Installing required packages...")
    import subprocess
    import sys

    subprocess.check_call(
        [sys.executable, "-m", "pip", "install", "requests", "python-dotenv"]
    )
    import requests
    from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

BASE_URL = "http://localhost:3000"
FIRECRAWL_API_KEY = os.getenv("FIRECRAWL_API_KEY")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")


def check_environment():
    """Verify environment variables are set"""
    if not FIRECRAWL_API_KEY:
        print("❌ FIRECRAWL_API_KEY not set")
        return False

    if not OPENAI_API_KEY:
        print("❌ OPENAI_API_KEY not set")
        return False

    print("✅ Environment variables verified")
    return True


def test_check_env_endpoint():
    """Test environment check endpoint"""
    print("\nTesting /api/check-env endpoint...")
    try:
        response = requests.get(f"{BASE_URL}/api/check-env")
        if response.status_code == 200:
            data = response.json()
            env_status = data.get("environmentStatus", {})
            if env_status.get("FIRECRAWL_API_KEY") and env_status.get("OPENAI_API_KEY"):
                print("✅ /api/check-env: All environment variables configured")
                return True
            else:
                print("❌ /api/check-env: Missing API keys in environment")
                return False
        else:
            print(f"❌ /api/check-env: HTTP {response.status_code}")
            return False
    except Exception as e:
        print(f"❌ /api/check-env: {e}")
        return False


def test_generate_fields():
    """Test field generation endpoint"""
    print("\nTesting /api/generate-fields endpoint...")
    try:
        headers = {
            "Content-Type": "application/json",
            "X-OpenAI-API-Key": OPENAI_API_KEY,
        }

        data = {
            "prompt": "Generate fields for company information including name and industry"
        }

        response = requests.post(
            f"{BASE_URL}/api/generate-fields", headers=headers, json=data
        )

        if response.status_code == 200:
            result = response.json()
            if result.get("success") and "fields" in result.get("data", {}):
                fields = result["data"]["fields"]
                print(f"✅ /api/generate-fields: Generated {len(fields)} fields")
                return True
            else:
                print("❌ /api/generate-fields: Unexpected response format")
                return False
        else:
            print(f"❌ /api/generate-fields: HTTP {response.status_code}")
            print(response.text)
            return False
    except Exception as e:
        print(f"❌ /api/generate-fields: {e}")
        return False


def test_scrape_endpoint():
    """Test web scraping endpoint"""
    print("\nTesting /api/scrape endpoint...")
    try:
        headers = {
            "Content-Type": "application/json",
            "X-Firecrawl-API-Key": FIRECRAWL_API_KEY,
        }

        data = {"url": "https://firecrawl.dev", "formats": ["markdown"]}

        response = requests.post(f"{BASE_URL}/api/scrape", headers=headers, json=data)

        if response.status_code == 200:
            result = response.json()
            if result.get("success") and "content" in result.get("data", {}):
                print("✅ /api/scrape: Successfully scraped website")
                return True
            else:
                print("❌ /api/scrape: Unexpected response format")
                return False
        elif response.status_code == 429:
            print("⚠️  /api/scrape: Rate limited (this is normal)")
            return True
        else:
            print(f"❌ /api/scrape: HTTP {response.status_code}")
            print(response.text)
            return False
    except Exception as e:
        print(f"❌ /api/scrape: {e}")
        return False


def test_enrich_endpoint():
    """Test email enrichment endpoint"""
    print("\nTesting /api/enrich endpoint...")
    try:
        headers = {
            "Content-Type": "application/json",
            "X-OpenAI-API-Key": OPENAI_API_KEY,
            "X-Firecrawl-API-Key": FIRECRAWL_API_KEY,
        }

        data = {
            "rows": [{"email": "eric@firecrawl.dev"}],
            "fields": [
                {
                    "name": "companyName",
                    "displayName": "Company Name",
                    "description": "The name of the company",
                    "type": "string",
                    "required": False,
                }
            ],
            "emailColumn": "email",
        }

        response = requests.post(f"{BASE_URL}/api/enrich", headers=headers, json=data)

        if response.status_code == 200:
            # Read a few lines of the streaming response
            lines = []
            for i, line in enumerate(response.iter_lines()):
                if i >= 5:  # Only read first 5 events
                    break
                if line:
                    lines.append(line.decode("utf-8"))

            # Check if we got valid SSE events
            valid_events = [line for line in lines if line.startswith("data: ")]
            if len(valid_events) > 0:
                print("✅ /api/enrich: Streaming response working")
                return True
            else:
                print("❌ /api/enrich: Invalid streaming response format")
                return False
        else:
            print(f"❌ /api/enrich: HTTP {response.status_code}")
            print(response.text)
            return False
    except Exception as e:
        print(f"❌ /api/enrich: {e}")
        return False


def main():
    """Main validation function"""
    print("Fireenrich API Validation")
    print("=" * 30)

    # Check environment
    if not check_environment():
        sys.exit(1)

    # Test endpoints
    tests = [
        test_check_env_endpoint,
        test_generate_fields,
        test_scrape_endpoint,
        test_enrich_endpoint,
    ]

    results = []
    for test in tests:
        try:
            result = test()
            results.append(result)
        except Exception as e:
            print(f"Test failed with exception: {e}")
            results.append(False)
        time.sleep(1)  # Brief pause between tests

    # Summary
    print("\n" + "=" * 30)
    print("Validation Summary:")
    passed = sum(results)
    total = len(results)
    print(f"Passed: {passed}/{total}")

    if passed == total:
        print("🎉 All tests passed! API is working correctly.")
        return 0
    else:
        print("❌ Some tests failed. Check output above.")
        return 1


if __name__ == "__main__":
    sys.exit(main())
