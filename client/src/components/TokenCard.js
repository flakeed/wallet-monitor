import React, { useState, useEffect } from 'react';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend);

function TokenCard({ token }) {
  const [priceData, setPriceData] = useState(null);

  useEffect(() => {
    const fetchTokenPrice = async () => {
      if (!token.mint) return;
      try {
        const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token.mint}`);
        const data = await response.json();
        if (data.pairs && data.pairs.length > 0) {
          const bestPair = data.pairs.reduce((prev, current) => 
            (current.volume?.h24 || 0) > (prev.volume?.h24 || 0) ? current : prev
          );
          setPriceData({
            price: parseFloat(bestPair.priceUsd || 0),
            change24h: parseFloat(bestPair.priceChange?.h24 || 0),
            volume24h: parseFloat(bestPair.volume?.h24 || 0),
          });
        }
      } catch (error) {
        console.error('Error fetching token price:', error);
      }
    };
    fetchTokenPrice();
  }, [token.mint]);

  // Simulate 24-hour price trend based on change24h
  const generateChartData = () => {
    if (!priceData) return { labels: [], datasets: [] };
    const currentPrice = priceData.price;
    const change24h = priceData.change24h / 100; // Convert percentage to decimal
    const initialPrice = currentPrice / (1 + change24h); // Reverse engineer starting price
    const step = (currentPrice - initialPrice) / 24;
    const dataPoints = Array.from({ length: 25 }, (_, i) => initialPrice + step * i);

    return {
      labels: Array.from({ length: 25 }, (_, i) => i * 1),
      datasets: [
        {
          label: 'Price (USD)',
          data: dataPoints,
          fill: false,
          borderColor: '#3b82f6',
          backgroundColor: '#3b82f6',
          tension: 0.1,
          pointRadius: 0,
        },
      ],
    };
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      x: { title: { display: false }, ticks: { display: false } },
      y: { title: { display: false }, ticks: { display: false } },
    },
    plugins: {
      legend: { display: false },
      tooltip: { enabled: false },
    },
  };

  return (
    <div className="border rounded-lg p-4 bg-gray-50">
      <div className="w-full h-32">
        <Line data={generateChartData()} options={chartOptions} />
      </div>
    </div>
  );
}

export default TokenCard;