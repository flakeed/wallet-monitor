import React, { useState, useEffect } from 'react';

const TelegramAuth = ({ onAuthSuccess, onAuthFailure }) => {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [authMethod, setAuthMethod] = useState('manual'); // Start with manual for development
  const [formData, setFormData] = useState({
    id: '',
    first_name: '',
    last_name: '',
    username: ''
  });

  const handleTelegramAuth = async (telegramData) => {
    setIsLoading(true);
    setError(null);

    try {
      // For development mode, we'll use the API_BASE from package.json proxy
      const response = await fetch('/api/auth/telegram', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(telegramData),
      });

      const result = await response.json();

      if (result.success) {
        localStorage.setItem('authToken', result.token);
        localStorage.setItem('userData', JSON.stringify(result.user));
        onAuthSuccess(result.user, result.token);
      } else {
        setError(result.message || 'Authentication failed');
        onAuthFailure(result.message);
      }
    } catch (error) {
      console.error('Auth error:', error);
      setError('Network error during authentication');
      onAuthFailure('Network error');
    } finally {
      setIsLoading(false);
    }
  };

  // Handle URL callback from Telegram (if using direct URL method)
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const hash = window.location.hash.substring(1);
    const hashParams = new URLSearchParams(hash);
    
    const telegramData = {};
    ['id', 'first_name', 'last_name', 'username', 'photo_url', 'auth_date', 'hash'].forEach(key => {
      const value = urlParams.get(key) || hashParams.get(key);
      if (value) telegramData[key] = value;
    });

    if (telegramData.id && telegramData.hash) {
      console.log('Found Telegram auth data in URL:', telegramData);
      handleTelegramAuth(telegramData);
    }
  }, []);

  const handleManualSubmit = (e) => {
    e.preventDefault();
    
    if (!formData.id) {
      setError('Telegram ID is required');
      return;
    }

    // Create auth data for manual testing - bypass hash verification for development
    const authData = {
      id: formData.id,
      first_name: formData.first_name || 'Test',
      last_name: formData.last_name || 'User',
      username: formData.username || '',
      auth_date: Math.floor(Date.now() / 1000),
      hash: 'development_mode_hash' // Special hash for development
    };

    handleTelegramAuth(authData);
  };

  const handleInputChange = (field, value) => {
    setFormData(prev => ({
      ...prev,
      [field]: value
    }));
  };

  const generateTelegramWidgetScript = () => {
    const botToken = process.env.REACT_APP_TELEGRAM_BOT_TOKEN;
    if (!botToken) return null;
    
    const botUsername = `test_walletpulse_bot`; // Примерное имя бота
    return {
      botUsername,
      authUrl: `https://t.me/${botUsername}?start=auth`
    };
  };

  const telegramInfo = generateTelegramWidgetScript();

  // Telegram Login Widget Integration
  useEffect(() => {
    if (authMethod === 'widget' && telegramInfo) {
      // Create Telegram Login Widget
      const script = document.createElement('script');
      script.src = 'https://telegram.org/js/telegram-widget.js?22';
      script.setAttribute('data-telegram-login', telegramInfo.botUsername);
      script.setAttribute('data-size', 'large');
      script.setAttribute('data-onauth', 'onTelegramAuth(user)');
      script.setAttribute('data-request-access', 'write');
      script.async = true;

      // Add global callback function
      window.onTelegramAuth = (user) => {
        console.log('Telegram widget auth:', user);
        handleTelegramAuth(user);
      };

      const widgetContainer = document.getElementById('telegram-widget-container');
      if (widgetContainer) {
        widgetContainer.innerHTML = '';
        widgetContainer.appendChild(script);
      }
    }

    return () => {
      // Cleanup
      if (window.onTelegramAuth) {
        delete window.onTelegramAuth;
      }
    };
  }, [authMethod, telegramInfo]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-900 via-blue-800 to-indigo-900 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-md">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-blue-600 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-white" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
            </svg>
          </div>
          <h1 className="text-3xl font-bold text-gray-900 mb-2">WalletPulse</h1>
          <p className="text-gray-600">Secure Solana Wallet Monitor</p>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
            <div className="flex items-center">
              <svg className="w-5 h-5 text-red-500 mr-2" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd"/>
              </svg>
              <span className="text-red-700 text-sm">{error}</span>
            </div>
          </div>
        )}

        {/* Auth Method Toggle */}
        <div className="mb-6">
          <div className="flex bg-gray-100 p-1 rounded-lg">
            <button
              onClick={() => setAuthMethod('manual')}
              className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors ${
                authMethod === 'manual'
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              Development Login
            </button>
            <button
              onClick={() => setAuthMethod('widget')}
              className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors ${
                authMethod === 'widget'
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              Telegram Widget
            </button>
            <button
              onClick={() => setAuthMethod('bot')}
              className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors ${
                authMethod === 'bot'
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              Bot Link
            </button>
          </div>
        </div>

        {authMethod === 'manual' ? (
          // Manual Development Login
          <div className="space-y-6">
            <div className="text-center">
              <h2 className="text-xl font-semibold text-gray-800 mb-4">
                Development Login
              </h2>
              <p className="text-sm text-gray-600 mb-6">
                Enter your Telegram details for testing
              </p>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Telegram ID *
                </label>
                <input
                  type="number"
                  value={formData.id}
                  onChange={(e) => handleInputChange('id', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="123456789"
                  disabled={isLoading}
                />
                <p className="text-xs text-gray-500 mt-1">
                  Get your ID from @userinfobot on Telegram
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    First Name
                  </label>
                  <input
                    type="text"
                    value={formData.first_name}
                    onChange={(e) => handleInputChange('first_name', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    placeholder="John"
                    disabled={isLoading}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Last Name
                  </label>
                  <input
                    type="text"
                    value={formData.last_name}
                    onChange={(e) => handleInputChange('last_name', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    placeholder="Doe"
                    disabled={isLoading}
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Username (optional)
                </label>
                <input
                  type="text"
                  value={formData.username}
                  onChange={(e) => handleInputChange('username', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="johndoe"
                  disabled={isLoading}
                />
              </div>

              <button
                onClick={handleManualSubmit}
                disabled={isLoading || !formData.id}
                className="w-full bg-green-600 text-white py-3 px-4 rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center space-x-2"
              >
                {isLoading ? (
                  <>
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
                    <span>Signing in...</span>
                  </>
                ) : (
                  <span>Sign in (Development)</span>
                )}
              </button>
            </div>

            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
              <div className="flex items-start">
                <svg className="w-5 h-5 text-yellow-600 mr-2 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd"/>
                </svg>
                <div>
                  <h4 className="text-sm font-medium text-yellow-800">Development Mode</h4>
                  <p className="text-xs text-yellow-700 mt-1">
                    This is for testing only. Make sure you've added your Telegram ID to the whitelist via the admin panel first.
                  </p>
                </div>
              </div>
            </div>
          </div>
        ) : authMethod === 'widget' ? (
          // Telegram Widget Method
          <div className="space-y-6">
            <div className="text-center">
              <h2 className="text-xl font-semibold text-gray-800 mb-4">
                Telegram Login Widget
              </h2>
              <p className="text-sm text-gray-600 mb-6">
                Click the Telegram button below to authenticate
              </p>
            </div>

            <div id="telegram-widget-container" className="text-center">
              {!telegramInfo && (
                <div className="text-center text-gray-500 p-4 border border-gray-200 rounded">
                  <p className="text-sm">Bot token not configured</p>
                  <p className="text-xs mt-1">Check REACT_APP_TELEGRAM_BOT_TOKEN in environment</p>
                </div>
              )}
            </div>

            {isLoading && (
              <div className="text-center py-4">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
                <p className="mt-2 text-sm text-gray-600">Authenticating...</p>
              </div>
            )}
          </div>
        ) : (
          // Bot Link Method
          <div className="space-y-6">
            <div className="text-center">
              <h2 className="text-xl font-semibold text-gray-800 mb-4">
                Telegram Bot Authentication
              </h2>
              <p className="text-sm text-gray-600 mb-6">
                Message your bot to get authenticated
              </p>
            </div>

            {telegramInfo ? (
              <div className="space-y-4">
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                  <h3 className="text-sm font-medium text-blue-900 mb-2">Step 1: Message your bot</h3>
                  <a
                    href={telegramInfo.authUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center space-x-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors"
                  >
                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.568 8.16c-.169 1.858-.896 6.728-.896 6.728-.377 2.655-1.407 3.119-2.896 1.928-.926-.74-1.474-1.38-2.38-2.233-.59-.555-.102-1.207.255-1.544.949-.897 2.083-1.946 2.775-2.617.37-.359.194-.578-.238-.345-1.095.589-2.784 1.876-3.992 2.656-.874.563-1.764.818-3.017.364-1.316-.476-2.835-1.02-2.835-1.02s-1.036-.653.731-1.347c4.612-1.839 10.29-4.098 15.582-6.049 1.998-.743 1.911 1.497 1.911 1.497z"/>
                    </svg>
                    <span>Open Telegram Bot</span>
                  </a>
                </div>

                <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                  <h3 className="text-sm font-medium text-gray-900 mb-2">Step 2: Send /start command</h3>
                  <p className="text-sm text-gray-600">
                    Type <code className="bg-gray-200 px-1 rounded">/start</code> to your bot and follow instructions
                  </p>
                </div>

                <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                  <h3 className="text-sm font-medium text-green-900 mb-2">Step 3: Wait for authentication</h3>
                  <p className="text-sm text-green-700">
                    After messaging the bot, you'll be automatically redirected here
                  </p>
                </div>

                {isLoading && (
                  <div className="text-center py-4">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
                    <p className="mt-2 text-sm text-gray-600">Waiting for Telegram authentication...</p>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center text-gray-500 p-4 border border-gray-200 rounded">
                <p className="text-sm">Bot token not configured</p>
                <p className="text-xs mt-1">Check REACT_APP_TELEGRAM_BOT_TOKEN in environment</p>
              </div>
            )}
          </div>
        )}

        <div className="mt-8 pt-6 border-t border-gray-200">
          <div className="text-center">
            <p className="text-xs text-gray-500 mb-2">
              Only whitelisted users can access this application.
            </p>
            <div className="flex items-center justify-center text-xs text-gray-500">
              <svg className="w-4 h-4 mr-2" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd"/>
              </svg>
              <span>Secure & Private</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TelegramAuth;